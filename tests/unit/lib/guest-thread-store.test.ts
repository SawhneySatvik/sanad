import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VerificationStatus } from "@/server/core/types";
import {
  appendMessage,
  createEmptyThread,
  DEFAULT_MAX_SERIALIZED_BYTES,
  deserializeThread,
  type GuestMessage,
  type GuestThread,
  loadThread,
  recentMessages,
  saveThread,
  serializeThread,
  type StorageBackend,
  toUnverifiedCachedStatus,
  type UnverifiedCachedStatus,
} from "@/lib/guest-thread-store";

function message(id: string, content: string): GuestMessage {
  return { id, role: "user", content, mode: null, citations: [], createdAtMs: Date.now() };
}

function fakeStorage(): StorageBackend & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("appendMessage — append-only", () => {
  it("returns a new thread with the message added at the end, never mutating the original", () => {
    const original = createEmptyThread("thread-1");
    const withOne = appendMessage(original, message("m1", "hello"));
    expect(original.messages).toHaveLength(0);
    expect(withOne.messages.map((m) => m.id)).toEqual(["m1"]);

    const withTwo = appendMessage(withOne, message("m2", "world"));
    expect(withOne.messages).toHaveLength(1);
    expect(withTwo.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("recentMessages — the identical slice-from-the-end contract as listRecentMessages", () => {
  function threadWith(n: number): GuestThread {
    let thread = createEmptyThread("t");
    for (let i = 0; i < n; i++) thread = appendMessage(thread, message(`m${i}`, `content-${i}`));
    return thread;
  }

  it("returns exactly the last N messages, in chronological order", () => {
    const thread = threadWith(15);
    const recent = recentMessages(thread, 5);
    expect(recent.map((m) => m.id)).toEqual(["m10", "m11", "m12", "m13", "m14"]);
  });

  it("clamps n to [0, messages.length] rather than over/under-slicing", () => {
    const thread = threadWith(3);
    expect(recentMessages(thread, 100).map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(recentMessages(thread, 0)).toEqual([]);
    expect(recentMessages(thread, -5)).toEqual([]);
  });

  it("a non-finite n (NaN/Infinity) returns an empty array rather than failing open to the whole array", () => {
    const thread = threadWith(5);
    // Array.prototype.slice(NaN) silently returns the WHOLE array (treats
    // NaN as 0) — exactly the "return everything, oldest included" failure
    // this function exists to prevent, just reached through a different
    // input than a too-large n.
    expect(recentMessages(thread, NaN)).toEqual([]);
    expect(recentMessages(thread, Infinity)).toEqual([]);
  });
});

describe("serializeThread / deserializeThread — round trip", () => {
  it("round-trips a thread through serialize -> deserialize unchanged", () => {
    let thread = createEmptyThread("thread-1", "My chat");
    thread = appendMessage(thread, message("m1", "hi"));
    thread = appendMessage(thread, {
      id: "m2",
      role: "assistant",
      content: "answer",
      mode: "grounded",
      citations: [
        {
          quoteText: "the notice period is 30 days",
          sourceDocumentId: "doc-1",
          unverifiedCachedStatus: toUnverifiedCachedStatus("verified"),
        },
      ],
      createdAtMs: Date.now(),
    });
    const json = serializeThread(thread);
    const back = deserializeThread(json, "unused-fallback");
    expect(back).toEqual(thread);
  });

  it("size cap: drops the OLDEST messages first until the serialized form fits", () => {
    let thread = createEmptyThread("thread-1");
    for (let i = 0; i < 50; i++) {
      thread = appendMessage(thread, message(`m${i}`, "x".repeat(200)));
    }
    const fullJson = serializeThread(thread, DEFAULT_MAX_SERIALIZED_BYTES);
    expect(JSON.parse(fullJson).messages).toHaveLength(50);

    // A cap small enough to force pruning, but large enough to keep some.
    const smallCap = new TextEncoder().encode(fullJson).length / 2;
    const capped = serializeThread(thread, smallCap);
    const cappedThread = deserializeThread(capped, "fallback") as GuestThread;
    expect(cappedThread.messages.length).toBeGreaterThan(0);
    expect(cappedThread.messages.length).toBeLessThan(50);
    // The newest message must survive; the oldest is what got dropped.
    expect(cappedThread.messages[cappedThread.messages.length - 1].id).toBe("m49");
    expect(cappedThread.messages.some((m) => m.id === "m0")).toBe(false);
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(smallCap);
  });

  it("size cap: converges (batch-drop, not one-at-a-time) even for a drastically oversized thread", () => {
    let thread = createEmptyThread("thread-1");
    for (let i = 0; i < 500; i++) {
      thread = appendMessage(thread, message(`m${i}`, "x".repeat(500)));
    }
    const tinyCap = 5_000; // far smaller than 500 * ~500+ bytes/message
    const capped = serializeThread(thread, tinyCap);
    const cappedThread = deserializeThread(capped, "fallback") as GuestThread;
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(tinyCap);
    expect(cappedThread.messages[cappedThread.messages.length - 1]?.id).toBe("m499");
  });

  // A skewed distribution (one huge old message, many tiny recent ones) must drop only the minimal
  // set needed to fit the cap — an averaged batch estimate would over-drop the small recent messages.
  it("size cap: SKEWED sizes (one huge old message, many tiny recent ones) drop exactly the minimal number needed, not an averaged batch", () => {
    let thread = createEmptyThread("thread-1");
    thread = appendMessage(thread, message("m0", "x".repeat(1_000_000))); // ~1MB, oldest
    for (let i = 1; i <= 99; i++) {
      thread = appendMessage(thread, message(`m${i}`, "y".repeat(100))); // ~100B each, recent
    }
    const cap = 500_000; // 500KB — dropping ONLY m0 fits comfortably
    const capped = serializeThread(thread, cap);
    const cappedThread = deserializeThread(capped, "fallback") as GuestThread;
    expect(cappedThread.messages.map((m) => m.id)).toEqual(Array.from({ length: 99 }, (_, i) => `m${i + 1}`));
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(cap);
  });

  // A pathologically large non-message field must not make the message-dropping loop drop every
  // message and still exceed the cap; title/documentIds are bounded before that loop runs.
  it("an oversized title (e.g. 3MB) is truncated before serialization, never silently wiping every message", () => {
    const hugeTitle = "T".repeat(3 * 1024 * 1024); // 3MB, alone bigger than the 2MB default cap
    let thread = createEmptyThread("thread-1", hugeTitle);
    thread = appendMessage(thread, message("m1", "hello"));
    const json = serializeThread(thread); // default 2MB cap
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(DEFAULT_MAX_SERIALIZED_BYTES);
    const back = deserializeThread(json, "fallback") as GuestThread;
    expect(back.title.length).toBeLessThan(hugeTitle.length);
    expect(back.messages).toHaveLength(1); // the message must survive — never silently wiped
  });

  it("an oversized documentIds array is capped to a sane count before serialization", () => {
    const manyDocs = Array.from({ length: 10_000 }, (_, i) => `doc-${i}`);
    let thread: GuestThread = { ...createEmptyThread("thread-1", "T"), documentIds: manyDocs };
    thread = appendMessage(thread, message("m1", "hello"));
    const json = serializeThread(thread);
    const back = deserializeThread(json, "fallback") as GuestThread;
    expect(back.documentIds.length).toBeLessThan(manyDocs.length);
    expect(back.messages).toHaveLength(1);
  });
});

// Compile-time proof that UnverifiedCachedStatus is genuinely not assignable to VerificationStatus
// in either direction. If the brand is ever dropped, `tsc --noEmit` fails here with "Unused
// '@ts-expect-error' directive" — a real, gate-checked assertion, not just a comment.
describe("UnverifiedCachedStatus — branded, not assignable to VerificationStatus", () => {
  it("neither direction type-checks without going through toUnverifiedCachedStatus", () => {
    const cached: UnverifiedCachedStatus = toUnverifiedCachedStatus("verified");

    // @ts-expect-error — a display-only, unverified cached status must never
    // type-check as verify()'s trusted VerificationStatus.
    const asTrusted: VerificationStatus = cached;

    // @ts-expect-error — a bare `VerificationStatus` literal doesn't type as
    // the disjoint UnverifiedCachedStatus union either; callers must go
    // through toUnverifiedCachedStatus().
    const bare: UnverifiedCachedStatus = "verified";

    // Runtime confirmation of the actual (disjoint, prefixed) representation
    // — the real proof is the two @ts-expect-error lines above, caught by tsc.
    expect(cached).toBe("cached_verified");
    void asTrusted;
    void bare;
  });
});

describe("deserializeThread — corrupt/malformed localStorage JSON never throws", () => {
  it("null (nothing stored yet) returns an empty thread", () => {
    const thread = deserializeThread(null, "fallback-id");
    expect(thread).toEqual(createEmptyThread("fallback-id"));
  });

  it("invalid JSON syntax returns an empty thread, not a throw", () => {
    expect(() => deserializeThread("{not valid json", "fallback-id")).not.toThrow();
    expect(deserializeThread("{not valid json", "fallback-id")).toEqual(createEmptyThread("fallback-id"));
  });

  it("valid JSON but the wrong shape (missing fields) returns an empty thread", () => {
    expect(deserializeThread(JSON.stringify({ hello: "world" }), "fallback-id")).toEqual(
      createEmptyThread("fallback-id"),
    );
  });

  it("valid JSON, right top-level shape, but a corrupt message inside `messages` returns an empty thread", () => {
    const corrupt = JSON.stringify({
      id: "t",
      title: "T",
      documentIds: [],
      messages: [{ id: "m1", role: "not-a-real-role", content: "x" }],
    });
    expect(deserializeThread(corrupt, "fallback-id")).toEqual(createEmptyThread("fallback-id"));
  });

  it("a bare JSON primitive (e.g. the number 5) returns an empty thread", () => {
    expect(deserializeThread("5", "fallback-id")).toEqual(createEmptyThread("fallback-id"));
  });

  it("an oversized raw string is rejected by byte length BEFORE JSON.parse ever runs, not a throw", () => {
    // Otherwise-valid JSON, just bigger than the cap — proves the pre-parse
    // check is a real size gate, not merely a parse-failure side effect.
    const huge = JSON.stringify(createEmptyThread("t", "x".repeat(200)));
    expect(() => deserializeThread(huge, "fallback-id", 10)).not.toThrow();
    expect(deserializeThread(huge, "fallback-id", 10)).toEqual(createEmptyThread("fallback-id"));
  });

  it("strips any extra (forged) field that survives the shape check, e.g. a devtools-injected top-level status", () => {
    const withForgedField = JSON.stringify({
      ...createEmptyThread("t", "T"),
      status: "verified", // not part of GuestThread — must not survive
      messages: [
        {
          id: "m1",
          role: "user",
          content: "hi",
          mode: null,
          citations: [
            {
              quoteText: "q",
              sourceDocumentId: "doc-1",
              unverifiedCachedStatus: "cached_not_found",
              verified: true, // forged extra field on a citation
            },
          ],
          createdAtMs: 1,
          extraTrustedFlag: true, // forged extra field on a message
        },
      ],
    });
    const back = deserializeThread(withForgedField, "fallback-id") as GuestThread & { status?: unknown };
    expect(back.status).toBeUndefined();
    expect(back.messages[0]).not.toHaveProperty("extraTrustedFlag");
    expect(back.messages[0].citations[0]).not.toHaveProperty("verified");
    expect(back.messages[0].citations[0].unverifiedCachedStatus).toBe("cached_not_found");
  });
});

describe("storage backend injection", () => {
  it("loadThread/saveThread round-trip through an injected backend, never touching a global", () => {
    const backend = fakeStorage();
    expect(loadThread(backend, "key-1")).toEqual(createEmptyThread("key-1"));

    let thread = createEmptyThread("key-1", "My chat");
    thread = appendMessage(thread, message("m1", "hi"));
    saveThread(backend, "key-1", thread);

    expect(backend.data.has("key-1")).toBe(true);
    expect(loadThread(backend, "key-1")).toEqual(thread);
  });

  it("structural check: the source file's CODE (comments stripped) never calls window/localStorage directly", () => {
    const path = join(process.cwd(), "src/lib/guest-thread-store.ts");
    const codeOnly = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/\bwindow\./);
    expect(codeOnly).not.toMatch(/\blocalStorage\b/);
  });
});
