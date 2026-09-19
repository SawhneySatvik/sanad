/**
 * Gemini adapter — @google/genai, native structured output via `responseJsonSchema` (always built by
 * provider-schema.ts, never raw `z.toJSONSchema` output) plus a system instruction.
 * `nativeDocumentInput` defaults to true; also serves Gemma models hosted on the Gemini API. The
 * transport is the real SDK's `GoogleGenAI(...).models` shape, injectable via the `transport`
 * constructor option so tests can supply a fake at the exact SDK boundary.
 */

import { GoogleGenAI } from "@google/genai";
import type { Content, Fetch, GenerateContentParameters, GenerateContentResponse, Part } from "@google/genai";
import type { ZodType } from "zod";
import { AppError } from "@/server/core/errors";
import { assertDocumentsWithinCapabilities } from "./capabilities";
import { normalizeProviderError, type ProviderCallContext, toStreamErrorEvent } from "./errors";
import { toProviderJsonSchema } from "./provider-schema";
import { assertSafeResponseSchema } from "./schema-guard";
import { combineTimeoutSignal } from "./signal";
import { completeStructured } from "./structured-output";
import type { LlmCapabilities, LlmClient, LlmCompleteInput, LlmDocumentInput, LlmStreamEvent, LlmTokensUsed } from "./types";

/** Used when no `model` option and no `GEMINI_MODEL` env var is set. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/** Real SDK response is a superset of this — only the fields this adapter reads. */
export type GeminiGenerateResult = Pick<GenerateContentResponse, "text" | "usageMetadata">;

/** The `GoogleGenAI(...).models` shape this adapter calls — injectable so tests can fake the SDK boundary. */
export interface GeminiModelsTransport {
  generateContent(params: GenerateContentParameters): Promise<GeminiGenerateResult>;
  generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GeminiGenerateResult>>;
}

/** Construction options for GeminiLlmClient. */
export interface GeminiLlmClientOptions {
  apiKey: string;
  model?: string;
  transport?: GeminiModelsTransport;
  /** Backstop for a call that passes no `timeoutMs`; a per-call `input.timeoutMs` always wins. */
  defaultTimeoutMs?: number;
  /** The default transport's own injectable fetch, forwarded to `new GoogleGenAI({...})`. */
  fetch?: Fetch;
  // False for a model the Gemini API serves that is not known to read raw files (Gemma): a request
  // carrying one is refused before any call, and a fallback chain skips this client for it.
  nativeDocumentInput?: boolean;
  // False for a model that rejects `thinkingConfig.thinkingBudget` (gemini-3.5-flash-lite answers 400
  // to a budget of 0): the caller's budget is then not sent and the model keeps its own default.
  sendThinkingBudget?: boolean;
}

/** Gemini adapter — see the module header for the contract. */
export class GeminiLlmClient implements LlmClient {
  readonly capabilities: LlmCapabilities;

  private readonly transport: GeminiModelsTransport;
  readonly model: string;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly errorContext: ProviderCallContext;
  private readonly sendThinkingBudget: boolean;

  constructor(options: GeminiLlmClientOptions) {
    this.capabilities = { structuredOutput: true, nativeDocumentInput: options.nativeDocumentInput ?? true, streaming: true };
    this.sendThinkingBudget = options.sendThinkingBudget ?? true;
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.errorContext = { model: this.model, apiKey: options.apiKey };
    this.transport =
      options.transport ??
      new GoogleGenAI({
        apiKey: options.apiKey,
        // `attempts: 1` = the original request only, no SDK-level retries: this adapter's own
        // caller (FallbackLlmClient) decides whether to spend a second call on another provider.
        // The SDK retrying internally first would burn quota/time before that decision is reached.
        httpOptions: { retryOptions: { attempts: 1 }, fetch: options.fetch },
      }).models;
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>) {
    assertSafeResponseSchema(input.schema);
    assertDocumentsWithinCapabilities(this.capabilities, input.documents);
    const signal = combineTimeoutSignal(input.signal, input.timeoutMs ?? this.defaultTimeoutMs);
    const jsonSchema = toProviderJsonSchema(input.schema);
    const baseParts = buildParts(input.userPrompt, input.documents);

    return completeStructured(input.schema, async (repairInstruction) => {
      const parts = repairInstruction ? [...baseParts, { text: repairInstruction }] : baseParts;
      const params: GenerateContentParameters = {
        model: this.model,
        contents: [{ role: "user", parts } satisfies Content],
        config: {
          systemInstruction: input.systemPrompt,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          abortSignal: signal,
          ...this.thinkingConfigOf(input),
        },
      };
      try {
        const response = await this.transport.generateContent(params);
        return {
          rawText: response.text ?? "",
          modelUsed: this.model,
          tokensUsed: usageOf(response),
        };
      } catch (error) {
        throw normalizeProviderError(error, signal, this.errorContext);
      }
    });
  }

  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    // Runs before any provider call and before the first `yield`: a bad schema throws synchronously
    // out of the first `.next()`, so zero events are ever emitted.
    assertSafeResponseSchema(input.schema);
    assertDocumentsWithinCapabilities(this.capabilities, input.documents);
    const signal = combineTimeoutSignal(input.signal, input.timeoutMs ?? this.defaultTimeoutMs);
    const jsonSchema = toProviderJsonSchema(input.schema);
    const baseParts = buildParts(input.userPrompt, input.documents);
    const config = {
      systemInstruction: input.systemPrompt,
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchema,
      abortSignal: signal,
      ...this.thinkingConfigOf(input),
    };

    let buffered = "";
    // Usage metadata arrives on the final chunk only; accumulate rather than assume a fixed chunk carries it.
    let streamedUsage: LlmTokensUsed = { input: 0, output: 0 };
    try {
      const stream = await this.transport.generateContentStream({
        model: this.model,
        contents: [{ role: "user", parts: baseParts } satisfies Content],
        config,
      });
      for await (const chunk of stream) {
        const piece = chunk.text ?? "";
        if (piece) {
          buffered += piece;
          yield { type: "token", token: piece };
        }
        if (chunk.usageMetadata) {
          streamedUsage = usageOf(chunk);
        }
      }
    } catch (error) {
      yield toStreamErrorEvent(normalizeProviderError(error, signal, this.errorContext));
      return;
    }

    try {
      const result = await completeStructured(input.schema, async (repairInstruction) => {
        if (!repairInstruction) {
          return { rawText: buffered, modelUsed: this.model, tokensUsed: streamedUsage };
        }
        try {
          const response = await this.transport.generateContent({
            model: this.model,
            contents: [{ role: "user", parts: [...baseParts, { text: repairInstruction }] } satisfies Content],
            config,
          });
          return { rawText: response.text ?? "", modelUsed: this.model, tokensUsed: usageOf(response) };
        } catch (error) {
          throw normalizeProviderError(error, signal, this.errorContext);
        }
      });
      yield { type: "done", data: result.data, modelUsed: result.modelUsed, tokensUsed: result.tokensUsed };
    } catch (error) {
      // Only a known AppError (SCHEMA_FAILED from completeStructured, or a provider error
      // normalizeProviderError already produced) becomes a stream "error" event — anything else is a
      // bug in this adapter and must not be misreported as a transient provider outage.
      if (error instanceof AppError) {
        yield toStreamErrorEvent(error);
        return;
      }
      throw error;
    }
  }

  // Only when the caller set one and this model takes it: otherwise the model keeps its own default.
  private thinkingConfigOf(input: { thinkingBudget?: number }): { thinkingConfig?: { thinkingBudget: number } } {
    return input.thinkingBudget === undefined || !this.sendThinkingBudget ? {} : { thinkingConfig: { thinkingBudget: input.thinkingBudget } };
  }
}

function usageOf(response: GeminiGenerateResult): LlmTokensUsed {
  return {
    input: response.usageMetadata?.promptTokenCount ?? 0,
    output: response.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

function buildParts(userPrompt: string, documents: LlmDocumentInput[] | undefined): Part[] {
  const parts: Part[] = [{ text: userPrompt }];
  for (const doc of documents ?? []) {
    if (doc.canonicalText !== undefined) {
      parts.push({ text: doc.canonicalText });
    } else if (doc.nativeFile) {
      parts.push({ inlineData: { mimeType: doc.nativeFile.mimeType, data: Buffer.from(doc.nativeFile.bytes).toString("base64") } });
    }
  }
  return parts;
}
