// The default fake for any code that depends on `LlmClient`. Implements the same contract as the
// real adapters — tests/unit/server/llm/fake.test.ts runs the exact same `runLlmContract` suite
// gemini.ts and gemma.ts run.

import type { ZodType } from "zod";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { assertDocumentsWithinCapabilities } from "@/server/llm/capabilities";
import { toStreamErrorEvent } from "@/server/llm/errors";
import { assertSafeResponseSchema } from "@/server/llm/schema-guard";
import { combineTimeoutSignal } from "@/server/llm/signal";
import { completeStructured } from "@/server/llm/structured-output";
import type { LlmCapabilities, LlmClient, LlmCompleteInput, LlmCompleteResult, LlmStreamEvent, LlmTokensUsed } from "@/server/llm/types";

type AnyCompleteInput = LlmCompleteInput<ZodType>;

// One provider attempt's scripted outcome.
export type FakeLlmAttempt =
  | { data: unknown; modelUsed?: string; tokensUsed?: Partial<LlmTokensUsed> } // shortcut: valid, pre-shaped data
  | { rawText: string; modelUsed?: string; tokensUsed?: Partial<LlmTokensUsed> } // for malformed-JSON / schema-mismatch scripting
  | { error: AppError } // thrown immediately — bypasses the repair loop, same as a real provider error
  | { hang: true }; // never settles until the call's AbortSignal fires, then rejects TIMEOUT

/** A queued attempt, or a function of the call so far — for scripting a response that depends on the repair instruction. */
export type FakeLlmScript = FakeLlmAttempt | ((ctx: { input: AnyCompleteInput; repairInstruction: string | undefined }) => FakeLlmAttempt);

/** Constructor options for `FakeLlmClient` — see `responses`/`defaultResponse` for the scripting model. */
export interface FakeLlmClientOptions {
  capabilities?: Partial<Pick<LlmCapabilities, "nativeDocumentInput" | "streaming">>;
  modelUsed?: string;
  // Queue, consumed FIFO, one entry per provider attempt. Exhausting it without a
  // `defaultResponse` throws — a fake that silently repeats its last scripted response would hide
  // a caller accidentally calling the client more times than it meant to.
  responses?: FakeLlmScript[];
  // Used only once the queue is empty; never consumed/removed. For tests that
  // don't care about exact call counts and just want "always answer X".
  defaultResponse?: FakeLlmScript;
}

/** Scriptable `LlmClient` double — see `FakeLlmClientOptions` for how to script its responses. */
export class FakeLlmClient implements LlmClient {
  readonly capabilities: LlmCapabilities;
  readonly calls: AnyCompleteInput[] = [];

  private readonly modelUsedDefault: string;
  private readonly queue: FakeLlmScript[];
  private readonly defaultResponse: FakeLlmScript | undefined;

  constructor(options: FakeLlmClientOptions = {}) {
    this.capabilities = {
      structuredOutput: true,
      nativeDocumentInput: options.capabilities?.nativeDocumentInput ?? false,
      streaming: options.capabilities?.streaming ?? true,
    };
    this.modelUsedDefault = options.modelUsed ?? "fake-model";
    this.queue = options.responses ? [...options.responses] : [];
    this.defaultResponse = options.defaultResponse;
  }

  /** Top-level `complete()`/`stream()` invocations only (not provider attempts). */
  get callCount(): number {
    return this.calls.length;
  }

  // Adds another scripted attempt after construction (e.g. giving a second
  // FakeLlmClient a different queue for a FallbackLlmClient test).
  enqueue(response: FakeLlmScript): void {
    this.queue.push(response);
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    assertSafeResponseSchema(input.schema);
    const genericInput = input as AnyCompleteInput;
    assertDocumentsWithinCapabilities(this.capabilities, genericInput.documents);
    const signal = combineTimeoutSignal(genericInput.signal, genericInput.timeoutMs);
    if (signal?.aborted) {
      throw new AppError("TIMEOUT", safeMessageFor("TIMEOUT"));
    }
    this.calls.push(genericInput);

    return completeStructured(input.schema, async (repairInstruction) => {
      const attempt = this.nextAttempt(genericInput, repairInstruction);
      return this.resolveAttempt(attempt, signal);
    });
  }

  // Structured to match a real adapter's stream(): the FIRST provider attempt's raw text is
  // emitted as "token" events BEFORE any validation happens, exactly like gemini.ts/gemma.ts. Only
  // that first attempt streams — a bounded repair retry is a non-streamed round-trip, same as real.
  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    assertSafeResponseSchema(input.schema);
    const genericInput = input as AnyCompleteInput;
    assertDocumentsWithinCapabilities(this.capabilities, genericInput.documents);
    const signal = combineTimeoutSignal(genericInput.signal, genericInput.timeoutMs);
    if (signal?.aborted) {
      yield toStreamErrorEvent(new AppError("TIMEOUT", safeMessageFor("TIMEOUT")));
      return;
    }
    this.calls.push(genericInput);

    let firstAttempt: { rawText: string; modelUsed: string; tokensUsed: LlmTokensUsed };
    try {
      const attempt = this.nextAttempt(genericInput, undefined);
      firstAttempt = await this.resolveAttempt(attempt, signal);
    } catch (error) {
      if (error instanceof AppError) {
        yield toStreamErrorEvent(error);
        return;
      }
      throw error;
    }
    for (const token of tokenize(firstAttempt.rawText)) {
      yield { type: "token", token };
    }

    let consumedFirst = false;
    try {
      const result = await completeStructured(input.schema, async (repairInstruction) => {
        if (!consumedFirst) {
          consumedFirst = true;
          return firstAttempt;
        }
        // The bounded repair retry — resolved fresh (no tokens emitted for it).
        const attempt = this.nextAttempt(genericInput, repairInstruction);
        return this.resolveAttempt(attempt, signal);
      });
      yield { type: "done", data: result.data, modelUsed: result.modelUsed, tokensUsed: result.tokensUsed };
    } catch (error) {
      if (error instanceof AppError) {
        yield toStreamErrorEvent(error);
        return;
      }
      throw error;
    }
  }

  private nextAttempt(input: AnyCompleteInput, repairInstruction: string | undefined): FakeLlmAttempt {
    const script = this.queue.length > 0 ? this.queue.shift()! : this.defaultResponse;
    if (script === undefined) {
      throw new Error(
        "FakeLlmClient: no scripted response left in the queue and no defaultResponse configured — " +
          "pass `responses`/call `.enqueue()` before invoking complete()/stream(), or set `defaultResponse` " +
          "for an 'always answer' fake.",
      );
    }
    return typeof script === "function" ? script({ input, repairInstruction }) : script;
  }

  private async resolveAttempt(
    attempt: FakeLlmAttempt,
    signal: AbortSignal | undefined,
  ): Promise<{ rawText: string; modelUsed: string; tokensUsed: LlmTokensUsed }> {
    if ("error" in attempt) {
      throw attempt.error;
    }
    if ("hang" in attempt) {
      return await new Promise((_resolve, reject) => {
        if (!signal) return; // never settles — caller must pass a signal/timeoutMs
        signal.addEventListener("abort", () => reject(new AppError("TIMEOUT", safeMessageFor("TIMEOUT"))), { once: true });
      });
    }
    const tokensUsed: LlmTokensUsed = { input: attempt.tokensUsed?.input ?? 0, output: attempt.tokensUsed?.output ?? 0 };
    const modelUsed = attempt.modelUsed ?? this.modelUsedDefault;
    if ("data" in attempt) {
      return { rawText: JSON.stringify(attempt.data), modelUsed, tokensUsed };
    }
    return { rawText: attempt.rawText, modelUsed, tokensUsed };
  }
}

function tokenize(text: string): string[] {
  return text.match(/.{1,8}/g) ?? [];
}
