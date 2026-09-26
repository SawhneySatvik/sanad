import { describe, expect, it } from "vitest";
import { generalChatCacheKey, parseCachedGeneralAnswer } from "@/server/orchestrator/general-cache";

const BASE = { specialistIds: ["tenancy"] as const, modelId: "m1", promptVersion: "orchestrator-v2" };

describe("generalChatCacheKey", () => {
  it("normalizes the question: trim, collapse whitespace, lowercase all share one key", () => {
    const a = generalChatCacheKey({ ...BASE, query: "  Can my landlord   keep my deposit?  " });
    const b = generalChatCacheKey({ ...BASE, query: "can my landlord keep my deposit?" });
    expect(a).toBe(b);
  });

  it("a different question is a different key", () => {
    const a = generalChatCacheKey({ ...BASE, query: "Can my landlord keep my deposit?" });
    const b = generalChatCacheKey({ ...BASE, query: "Can my employer withhold my salary?" });
    expect(a).not.toBe(b);
  });

  it("a different specialist set, model id or prompt version is a different key", () => {
    const base = generalChatCacheKey({ ...BASE, query: "same question" });
    expect(generalChatCacheKey({ ...BASE, query: "same question", specialistIds: ["employment"] })).not.toBe(base);
    expect(generalChatCacheKey({ ...BASE, query: "same question", modelId: "m2" })).not.toBe(base);
    expect(generalChatCacheKey({ ...BASE, query: "same question", promptVersion: "orchestrator-v3" })).not.toBe(base);
  });

  it("a situation/role, when passed, changes the key; when absent on both sides, matches", () => {
    const noRole = generalChatCacheKey({ ...BASE, query: "same question" });
    const withRole = generalChatCacheKey({ ...BASE, query: "same question", situationOrRole: "tenant" });
    expect(withRole).not.toBe(noRole);
  });
});

describe("parseCachedGeneralAnswer", () => {
  it("round-trips a well-formed entry", () => {
    const raw = JSON.stringify({ answer: "text", modelUsed: "m1", routedDomains: ["tenancy"] });
    expect(parseCachedGeneralAnswer(raw)).toEqual({ answer: "text", modelUsed: "m1", routedDomains: ["tenancy"] });
  });

  it("rejects malformed JSON, a non-object, and a wrong-shaped entry — a miss, never a throw", () => {
    expect(parseCachedGeneralAnswer("{not json")).toBeNull();
    expect(parseCachedGeneralAnswer("null")).toBeNull();
    expect(parseCachedGeneralAnswer(JSON.stringify("just a string"))).toBeNull();
    expect(parseCachedGeneralAnswer(JSON.stringify({ answer: "text" }))).toBeNull();
    expect(parseCachedGeneralAnswer(JSON.stringify({ answer: 1, modelUsed: "m1", routedDomains: [] }))).toBeNull();
    expect(parseCachedGeneralAnswer(JSON.stringify({ answer: "text", modelUsed: "m1", routedDomains: [1, 2] }))).toBeNull();
  });

  it("ignores extra smuggled fields (e.g. a self-certified status) — only answer/modelUsed/routedDomains are ever read out", () => {
    const raw = JSON.stringify({ answer: "text", modelUsed: "m1", routedDomains: ["tenancy"], status: "verified", spanStart: 0, spanEnd: 4 });
    expect(parseCachedGeneralAnswer(raw)).toEqual({ answer: "text", modelUsed: "m1", routedDomains: ["tenancy"] });
  });
});
