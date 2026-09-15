// Shared harness for the Ask service and message_citations tests: real PGlite (createRepoTestDb),
// real documents and threads made through the repositories, the real orchestrator and verify(),
// FakeLlmClient at the provider boundary — nothing else is faked (CLAUDE.md mocking policy).

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { ZodType } from "zod";
import type { TestDb } from "@tests/support/db";
import type { InputMode, Principal } from "@/server/core/types";
import type { Document } from "@/server/data/documents";
import { createRepoTestDb, pendingDocument, readyDocument } from "@tests/support/data/documents";
import { attachDocument, createThread, type Thread } from "@/server/data/threads";
import type { FakeLlmAttempt } from "@tests/support/fakes/llm-client";
import type { LlmClient, LlmCompleteInput, LlmCompleteResult, LlmStreamEvent } from "@/server/llm/types";
import type { AskDeps, AskEvent, AssistantMessage } from "@/server/services/ask";

export { caught, guestA, guestB, userA, userB, USER_A_ID, USER_B_ID } from "@tests/support/data/documents";

/** The default grounding document `createAskHarness().document()` attaches when no text is given. */
export const LEASE = readFileSync(path.join(process.cwd(), "tests", "fixtures", "documents", "leave_and_license.txt"), "utf8");

// Each sits on one line of LEASE, so canonicalText.slice(spanStart, spanEnd) must equal it exactly.
export const QUOTES = {
  deposit: "The security deposit shall be refunded within 15 days of vacating the premises",
  lockIn: "There shall be a lock-in period of three (3) months from the commencement date",
  fabricated: "The Licensee may sublet the premises without the Licensor's consent",
} as const;

// The orchestrator's non-LLM classifier sends each of these to exactly one specialist (tenancy),
// so a turn is one streamed model call.
export const GROUNDED_QUERY = "When will my landlord return my deposit?";
/** Legal but not grounded in any document — routes to general mode, still one streamed call. */
export const GENERAL_QUERY = "Can my landlord keep my deposit?";
// No legal angle: the orchestrator's redirect, no model call at all.
export const NON_LEGAL_QUERY = "write me a short poem about the rain";
// With a leave-and-license document attached, two specialists (tenancy, employment): two complete()
// calls, then one streamed synthesis call — three LLM calls in one turn.
export const TWO_SPECIALIST_QUERY = "my rental agreement notice period and my employment offer letter probation period";

/** A scripted FakeLlmClient attempt shaped like a real Ask model response. */
export function answer(
  text: string,
  citations: readonly { quote: string; sourceDocumentId: string }[] = [],
  modelUsed?: string,
): FakeLlmAttempt {
  return { data: { answer: text, citations }, modelUsed };
}

/** Drains an Ask event stream into an array, for tests that assert on the whole sequence. */
export async function collect(events: AsyncIterable<AskEvent>): Promise<AskEvent[]> {
  const out: AskEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

// The one final event, which must be the last event.
export function finalMessage(events: readonly AskEvent[]): AssistantMessage {
  const last = events[events.length - 1];
  if (last?.type !== "final" || events.filter((event) => event.type === "final").length !== 1) {
    throw new Error(`expected exactly one final event, last; got ${JSON.stringify(events.map((event) => event.type))}`);
  }
  return last.message;
}

/** The Ask service test harness: a real DB, document/thread builders, row counters, and a `deps()` builder for a given LlmClient. */
export interface AskHarness {
  t: TestDb;
  deps(llm: LlmClient): AskDeps;
  document(principal: Principal, text?: string, inputMode?: InputMode): Promise<Document>;
  pending(principal: Principal): Promise<Document>;
  // A saved thread (user principals only) with `documents` attached.
  thread(principal: Principal, documents?: readonly Document[]): Promise<Thread>;
  counts(): Promise<{ threads: number; messages: number; citations: number }>;
  close(): Promise<void>;
}

/** Builds a fresh Ask service `AskHarness` over its own isolated database. */
export async function createAskHarness(): Promise<AskHarness> {
  const t = await createRepoTestDb();
  async function count(table: string): Promise<number> {
    const result = await t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return result.rows[0].n;
  }
  return {
    t,
    deps: (llm) => ({ db: t.db, llm }),
    document: (principal, text = LEASE, inputMode = "text") => readyDocument(t, principal, text, inputMode),
    pending: (principal) => pendingDocument(t, principal),
    thread: async (principal, documents = []) => {
      const thread = await createThread(t.db, principal, { title: "Lease questions" });
      for (const document of documents) await attachDocument(t.db, principal, thread.id, document.id);
      return thread;
    },
    counts: async () => ({
      threads: await count("threads"),
      messages: await count("messages"),
      citations: await count("message_citations"),
    }),
    close: () => t.close(),
  };
}

// Calls `hook` with each event of a streamed call just before passing it on — lets a test act at an
// exact point of the model call (its first token, its "done").
export class HookedLlmClient implements LlmClient {
  readonly capabilities: LlmClient["capabilities"];

  constructor(
    private readonly inner: LlmClient,
    private readonly hook: (event: LlmStreamEvent<ZodType>) => void,
  ) {
    this.capabilities = inner.capabilities;
  }

  complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    return this.inner.complete(input);
  }

  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    for await (const event of this.inner.stream(input)) {
      this.hook(event);
      yield event;
    }
  }
}

// PGlite has one connection: a query issued while a transaction is open waits for it to finish, so
// a probe query that cannot complete within PROBE_MS means the caller holds a transaction open
// across the model call. Wraps the fake client and probes at call start and stream completion.
const PROBE_MS = 300;

/** Wraps a real LlmClient and probes whether the DB connection is free at call start and stream end. */
export class DbProbingLlmClient implements LlmClient {
  readonly capabilities: LlmClient["capabilities"];
  readonly probes: ("free" | "blocked")[] = [];

  constructor(
    private readonly inner: LlmClient,
    private readonly client: PGlite,
  ) {
    this.capabilities = inner.capabilities;
  }

  private async probe(): Promise<void> {
    const outcome = await Promise.race([
      this.client.query("SELECT 1").then(() => "free" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), PROBE_MS)),
    ]);
    this.probes.push(outcome);
  }

  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    await this.probe();
    return this.inner.complete(input);
  }

  async *stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    await this.probe();
    const events: LlmStreamEvent<Schema>[] = [];
    for await (const event of this.inner.stream(input)) {
      if (event.type !== "token") events.push(event);
      else yield event;
    }
    await this.probe();
    yield* events;
  }
}
