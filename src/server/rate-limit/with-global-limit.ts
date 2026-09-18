/**
 * Decorator making the shared, app-wide outbound Gemini/Gemma quota concrete at the LlmClient
 * boundary. Don't hand-compose this per adapter — the blessed factory wraps each leaf adapter with
 * this decorator inside a fallback client, and wraps the whole thing with the caller-limit
 * decorator outside it. Fails fast: the atomic increment against the provider's global bucket runs
 * before the inner client is touched at all; over the limit, inner is never called.
 */

import type { ZodType } from "zod";
import type { Db } from "@/db/client";
import { AppError } from "@/server/core/errors";
import { toStreamErrorEvent } from "@/server/llm/errors";
import type {
  LlmCapabilities,
  LlmClient,
  LlmCompleteInput,
  LlmCompleteResult,
  LlmStreamEvent,
} from "@/server/llm/types";
import { assertValidLimitOverride, enforceGlobalLimit, type Clock, type ProviderKey } from "./limiter";

/** Options for withGlobalLimit: which provider's shared bucket to charge, and overrides for tests. */
export interface WithGlobalLimitOptions {
  db: Db;
  providerKey: ProviderKey;
  limit?: number;
  clock?: Clock;
}

class GlobalLimitedLlmClient implements LlmClient {
  readonly capabilities: LlmCapabilities;

  constructor(
    private readonly inner: LlmClient,
    private readonly opts: WithGlobalLimitOptions,
  ) {
    // Validated here, at construction, not lazily on first use — a misconfigured `opts.limit`
    // fails at startup/composition time, not silently on the first real request.
    assertValidLimitOverride(`withGlobalLimit(${opts.providerKey}).opts.limit`, opts.limit);
    this.capabilities = inner.capabilities;
  }

  private enforce(): Promise<unknown> {
    return enforceGlobalLimit(this.opts.db, this.opts.providerKey, { limit: this.opts.limit, clock: this.opts.clock });
  }

  // Throws the typed AppError, matching every adapter's contract.
  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    await this.enforce();
    return this.inner.complete(input);
  }

  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    try {
      await this.enforce();
    } catch (error) {
      // Only a RATE_LIMITED AppError becomes a stream event; any other error or event from
      // `inner` is rethrown/re-yielded completely unchanged, so a non-retryable provider error's
      // real `retryable: false` survives decoration exactly.
      if (error instanceof AppError && error.code === "RATE_LIMITED") {
        yield toStreamErrorEvent(error);
        return;
      }
      throw error;
    }
    yield* this.inner.stream(input);
  }
}

/** Wraps `inner` with the shared per-provider global rate limit. */
export function withGlobalLimit(inner: LlmClient, opts: WithGlobalLimitOptions): LlmClient {
  return new GlobalLimitedLlmClient(inner, opts);
}
