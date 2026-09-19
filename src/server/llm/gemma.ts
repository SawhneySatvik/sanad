/**
 * Gemma adapter — an OpenAI-compatible chat-completions client parameterized by baseURL/apiKey/model,
 * so the same class serves NVIDIA NIM and OpenRouter (Gemma on Google AI Studio goes through
 * gemini.ts instead). `nativeDocumentInput: false`: neither gateway accepts raw file bytes, only
 * text. Neither guarantees schema-constrained decoding, so this adapter sends `response_format:
 * { type: "json_object" }` plus the schema in the system prompt; `completeStructured`'s bounded
 * repair retry is the actual enforcement. The transport is injectable via the `transport` option.
 */

import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { ZodType } from "zod";
import { AppError } from "@/server/core/errors";
import { assertDocumentsWithinCapabilities } from "./capabilities";
import { normalizeProviderError, type ProviderCallContext, toStreamErrorEvent } from "./errors";
import { toProviderJsonSchema } from "./provider-schema";
import { assertSafeResponseSchema } from "./schema-guard";
import { combineTimeoutSignal } from "./signal";
import { completeStructured } from "./structured-output";
import type { LlmCapabilities, LlmClient, LlmCompleteInput, LlmDocumentInput, LlmStreamEvent, LlmTokensUsed } from "./types";

/** Default for direct `GemmaLlmClient` construction outside providers.ts, which sets each gateway's own id instead. */
export const DEFAULT_GEMMA_MODEL = "google/gemma-4-31b-it";

/** Real SDK response is a superset of this — only the fields this adapter reads. */
export type GemmaCompletionResult = Pick<ChatCompletion, "choices" | "usage">;
/** Real SDK stream chunk is a superset of this — only the fields this adapter reads. */
export type GemmaCompletionChunk = Pick<ChatCompletionChunk, "choices" | "usage">;

/** The `chat.completions.create` shape this adapter calls — injectable so tests can fake the SDK boundary. */
export interface GemmaChatClient {
  createChat(params: ChatCompletionCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<GemmaCompletionResult>;
  createChatStream(params: ChatCompletionCreateParamsStreaming, options?: { signal?: AbortSignal }): Promise<AsyncIterable<GemmaCompletionChunk>>;
}

/** Construction options for GemmaLlmClient. */
export interface GemmaLlmClientOptions {
  apiKey: string;
  baseURL: string;
  model?: string;
  transport?: GemmaChatClient;
  /** Backstop for a call that passes no `timeoutMs`; a per-call `input.timeoutMs` always wins. */
  defaultTimeoutMs?: number;
  /** The default transport's own injectable fetch, forwarded to `new OpenAI({ fetch })`. */
  fetch?: typeof fetch;
}

/** Gemma adapter — see the module header for the contract. */
export class GemmaLlmClient implements LlmClient {
  readonly capabilities: LlmCapabilities = { structuredOutput: true, nativeDocumentInput: false, streaming: true };

  private readonly transport: GemmaChatClient;
  readonly model: string;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly errorContext: ProviderCallContext;

  constructor(options: GemmaLlmClientOptions) {
    this.model = options.model ?? DEFAULT_GEMMA_MODEL;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.errorContext = { model: this.model, apiKey: options.apiKey };
    this.transport = options.transport ?? buildDefaultGemmaChatClient(options.apiKey, options.baseURL, options.fetch);
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>) {
    assertSafeResponseSchema(input.schema);
    assertDocumentsWithinCapabilities(this.capabilities, input.documents);
    const signal = combineTimeoutSignal(input.signal, input.timeoutMs ?? this.defaultTimeoutMs);
    const jsonSchema = toProviderJsonSchema(input.schema);
    const userContent = buildUserContent(input.userPrompt, input.documents);

    return completeStructured(input.schema, async (repairInstruction) => {
      const params: ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(input.systemPrompt, jsonSchema) },
          { role: "user", content: repairInstruction ? `${userContent}\n\n${repairInstruction}` : userContent },
        ],
      };
      try {
        const response = await this.transport.createChat(params, { signal });
        return {
          rawText: response.choices[0]?.message?.content ?? "",
          modelUsed: this.model,
          tokensUsed: usageOf(response.usage),
        };
      } catch (error) {
        throw normalizeProviderError(error, signal, this.errorContext);
      }
    });
  }

  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    // Before any provider call, and before the first `yield` — see the
    // matching comment in gemini.ts's stream().
    assertSafeResponseSchema(input.schema);
    assertDocumentsWithinCapabilities(this.capabilities, input.documents);
    const signal = combineTimeoutSignal(input.signal, input.timeoutMs ?? this.defaultTimeoutMs);
    const jsonSchema = toProviderJsonSchema(input.schema);
    const system = buildSystemPrompt(input.systemPrompt, jsonSchema);
    const userContent = buildUserContent(input.userPrompt, input.documents);

    let buffered = "";
    let usage: LlmTokensUsed = { input: 0, output: 0 };
    try {
      const stream = await this.transport.createChatStream(
        {
          model: this.model,
          stream: true,
          stream_options: { include_usage: true },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          buffered += delta;
          yield { type: "token", token: delta };
        }
        if (chunk.usage) {
          usage = usageOf(chunk.usage);
        }
      }
    } catch (error) {
      yield toStreamErrorEvent(normalizeProviderError(error, signal, this.errorContext));
      return;
    }

    try {
      const result = await completeStructured(input.schema, async (repairInstruction) => {
        if (!repairInstruction) {
          return { rawText: buffered, modelUsed: this.model, tokensUsed: usage };
        }
        try {
          const repaired = await this.transport.createChat(
            {
              model: this.model,
              stream: false,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: system },
                { role: "user", content: `${userContent}\n\n${repairInstruction}` },
              ],
            },
            { signal },
          );
          return { rawText: repaired.choices[0]?.message?.content ?? "", modelUsed: this.model, tokensUsed: usageOf(repaired.usage) };
        } catch (error) {
          throw normalizeProviderError(error, signal, this.errorContext);
        }
      });
      yield { type: "done", data: result.data, modelUsed: result.modelUsed, tokensUsed: result.tokensUsed };
    } catch (error) {
      // Same rule as gemini.ts's stream(): only a known AppError becomes a
      // stream "error" event; an unexpected bug rethrows instead of being
      // silently misreported as a transient provider outage.
      if (error instanceof AppError) {
        yield toStreamErrorEvent(error);
        return;
      }
      throw error;
    }
  }
}

function buildDefaultGemmaChatClient(apiKey: string, baseURL: string, fetch?: typeof globalThis.fetch): GemmaChatClient {
  const client = new OpenAI({
    apiKey,
    baseURL,
    // No SDK-level retries — same reasoning as GeminiLlmClient's default transport (gemini.ts):
    // FallbackLlmClient, not the SDK, decides whether to spend a second call on another provider.
    maxRetries: 0,
    fetch,
  });
  return {
    createChat: (params, options) => client.chat.completions.create(params, options),
    createChatStream: (params, options) => client.chat.completions.create(params, options),
  };
}

function usageOf(usage: { prompt_tokens?: number; completion_tokens?: number } | null | undefined): LlmTokensUsed {
  return { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0 };
}

function buildUserContent(userPrompt: string, documents: LlmDocumentInput[] | undefined): string {
  const documentText = (documents ?? [])
    .map((doc) => doc.canonicalText)
    .filter((text): text is string => Boolean(text))
    .join("\n\n---\n\n");
  return documentText ? `${userPrompt}\n\n${documentText}` : userPrompt;
}

function buildSystemPrompt(systemPrompt: string, jsonSchema: unknown): string {
  return (
    `${systemPrompt}\n\nRespond with ONLY a single JSON object matching this JSON Schema exactly ` +
    `(no extra keys, no commentary, no markdown fences):\n${JSON.stringify(jsonSchema)}`
  );
}
