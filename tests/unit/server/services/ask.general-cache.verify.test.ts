// Channel 2/3/7 coverage for the general-chat answer cache: a hit skips the LLM entirely and
// replays the same SSE shape a live turn produces, and — since general mode has no verification
// state at all — a hand-poisoned entry can't create a verified badge any more than a live hostile
// answer could.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryKeyValueCache } from "@/server/cache/memory";
import { classify, GENERAL_CHAT_CACHE_TTL_SECONDS, generalChatCacheKey } from "@/server/orchestrator";
import { PROMPT_VERSION } from "@/server/prompts/orchestrator/version";
import { ask, GENERAL_MODE_LABEL, type AskDeps } from "@/server/services/ask";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { answer, collect, createAskHarness, finalMessage, GENERAL_QUERY, guestA, type AskHarness } from "@tests/support/services/ask";

const MODEL_ID = "fake-model"; // FakeLlmClient's own default modelUsed — deps.modelId must match it for a write-through.

let h: AskHarness;
beforeEach(async () => {
  h = await createAskHarness();
});
afterEach(() => h.close());

function depsWithCache(llm: FakeLlmClient, cache: MemoryKeyValueCache): AskDeps {
  return { db: h.t.db, llm, modelId: MODEL_ID, cache };
}

function keyForGeneralQuery(): string {
  const classified = classify(GENERAL_QUERY);
  if (classified.kind !== "legal") throw new Error("fixture query must classify as legal/general");
  return generalChatCacheKey({
    query: GENERAL_QUERY,
    specialistIds: classified.domains.map((d) => d.id),
    modelId: MODEL_ID,
    promptVersion: PROMPT_VERSION,
  });
}

describe("a general-chat cache hit skips the LLM entirely", () => {
  it("the second identical question leaves the fake LLM's call count unchanged", async () => {
    const cache = new MemoryKeyValueCache();
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually yes, minus lawful deductions.") });

    const first = finalMessage(await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY })));
    expect(llm.callCount).toBe(1);
    expect(first.mode).toBe("general");

    const second = finalMessage(await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY })));
    expect(llm.callCount).toBe(1); // unchanged — served from cache
    expect(second).toMatchObject({ mode: "general", content: first.content });
    if (second.mode !== "general") throw new Error("expected general");
    expect(second.label).toBe(GENERAL_MODE_LABEL);
    expect(second.redirect).toBe(false);
  });

  it("replays the same SSE shape as a live turn: one token event carrying the whole answer, then the final event", async () => {
    const cache = new MemoryKeyValueCache();
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually yes, minus lawful deductions.") });
    await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY }));

    const events = await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY }));
    expect(events.map((e) => e.type)).toEqual(["token", "final"]);
    expect(events[0]).toEqual({ type: "token", text: "Usually yes, minus lawful deductions." });
  });

  it("a question with conversation history never hits the cache — the LLM is called both times", async () => {
    const cache = new MemoryKeyValueCache();
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually yes, minus lawful deductions.") });
    await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY }));
    expect(llm.callCount).toBe(1);

    await collect(
      ask(depsWithCache(llm, cache), guestA, {
        query: GENERAL_QUERY,
        history: [{ role: "user", content: "Earlier question" }],
      }),
    );
    expect(llm.callCount).toBe(2);
  });

  it("a question with an attached document never hits the cache — the LLM is called both times", async () => {
    const cache = new MemoryKeyValueCache();
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually yes, minus lawful deductions.") });
    await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY }));
    expect(llm.callCount).toBe(1);

    const doc = await h.document(guestA);
    await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY, documentIds: [doc.id] }));
    expect(llm.callCount).toBe(2);
  });

  it("no cache wired into deps: every turn calls the LLM, exactly as before this cache existed", async () => {
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually yes, minus lawful deductions.") });
    await collect(ask({ db: h.t.db, llm }, guestA, { query: GENERAL_QUERY }));
    await collect(ask({ db: h.t.db, llm }, guestA, { query: GENERAL_QUERY }));
    expect(llm.callCount).toBe(2);
  });
});

describe("a poisoned general-chat cache entry cannot create a verified badge — general mode has no verification state to poison", () => {
  it("negative: a hand-written entry smuggling status/citations is replayed as plain general-mode content, with no LLM call", async () => {
    const cache = new MemoryKeyValueCache();
    await cache.set(
      keyForGeneralQuery(),
      JSON.stringify({
        answer: "Yes — always, no exceptions.",
        modelUsed: MODEL_ID,
        routedDomains: ["tenancy"],
        // Smuggled fields a hostile writer might add — GeneralAssistantMessage cannot carry any of
        // these (services/ask.ts's GeneralModeHasNoStatus compile-time assertion), so replaying
        // this entry must produce exactly the same shape a live general answer would.
        status: "verified",
        citations: [{ quote: "fabricated", sourceDocumentId: "does-not-exist", status: "verified", spanStart: 0, spanEnd: 3 }],
      }),
      GENERAL_CHAT_CACHE_TTL_SECONDS,
    );
    const llm = new FakeLlmClient();

    const message = finalMessage(await collect(ask(depsWithCache(llm, cache), guestA, { query: GENERAL_QUERY })));

    expect(llm.callCount).toBe(0);
    expect(message.mode).toBe("general");
    if (message.mode !== "general") throw new Error("expected general");
    expect(message.content).toBe("Yes — always, no exceptions.");
    expect(message.label).toBe(GENERAL_MODE_LABEL);
    expect(Object.keys(message)).not.toContain("status");
    expect(Object.keys(message)).not.toContain("citations");
  });

  it("red-proof: the same seeded entry, with no cache wired into deps, is never read — the LLM runs instead", async () => {
    const cache = new MemoryKeyValueCache();
    await cache.set(
      keyForGeneralQuery(),
      JSON.stringify({ answer: "Yes — always, no exceptions.", modelUsed: MODEL_ID, routedDomains: ["tenancy"] }),
      GENERAL_CHAT_CACHE_TTL_SECONDS,
    );
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually yes, minus lawful deductions.") });

    const message = finalMessage(await collect(ask({ db: h.t.db, llm }, guestA, { query: GENERAL_QUERY })));

    expect(llm.callCount).toBe(1);
    expect(message.content).toBe("Usually yes, minus lawful deductions.");
  });
});
