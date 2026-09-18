import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@/db/ids";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";
import type { Principal } from "@/server/core/types";
import { createThread } from "@/server/data/threads";
import { appendMessage, listRecentMessages, MAX_RECENT_MESSAGES_LIMIT } from "@/server/data/messages";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const principalA: Principal = { type: "user", userId: USER_A };
const principalB: Principal = { type: "user", userId: USER_B };

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  await t.db.insert(schema.users).values([
    { id: USER_A, email: "a@example.com" },
    { id: USER_B, email: "b@example.com" },
  ]);
});
afterEach(async () => {
  await t.close();
});

async function makeThread(owner: Principal, title = "Thread"): Promise<string> {
  const thread = await createThread(t.db, owner, { title });
  return thread.id;
}

// Inserts rows directly (bypassing appendMessage) so createdAt can be forced
// into ties — real same-millisecond/same-transaction inserts. `id` is still
// a real newId() (UUIDv7, monotonic), matching how the DB is actually
// populated: id order always agrees with true chronological order even when
// two rows share an identical created_at.
async function insertRawMessages(
  threadId: string,
  specs: { content: string; createdAt: Date }[],
): Promise<{ id: string; content: string }[]> {
  const rows = specs.map((s) => ({
    id: newId(),
    threadId,
    role: "user" as const,
    content: s.content,
    mode: null,
    routedDomainArray: null,
    modelUsed: null,
    createdAt: s.createdAt,
  }));
  await t.db.insert(schema.messages).values(rows);
  return rows.map((r) => ({ id: r.id, content: r.content }));
}

describe("listRecentMessages — tied created_at timestamps at the LIMIT boundary", () => {
  it("returns exactly the last N messages, in chronological order, when the LIMIT boundary falls INSIDE a tied (same-millisecond) group", async () => {
    const threadId = await makeThread(principalA);

    // 3 groups of 5, each group sharing an identical created_at (simulating
    // same-millisecond / same-transaction inserts). N=7 deliberately does
    // NOT align with a group boundary (5, 10, 15) — the last 7 span the
    // tail of group 1 (indices 5-9) and all of group 2 (indices 10-14), so
    // id (UUIDv7, monotonic) must correctly decide WHICH rows of the tied
    // group 1 make the cut, not just their relative order once selected.
    const baseTime = new Date("2026-01-01T00:00:00.000Z");
    const specs = Array.from({ length: 15 }, (_, i) => ({
      content: `message-${i}`,
      createdAt: new Date(baseTime.getTime() + Math.floor(i / 5) * 1000),
    }));
    await insertRawMessages(threadId, specs);

    const recent = await listRecentMessages(t.db, principalA, threadId, 7);
    expect(recent.map((m) => m.content)).toEqual([
      "message-8",
      "message-9",
      "message-10",
      "message-11",
      "message-12",
      "message-13",
      "message-14",
    ]);
  });

  it("id DESC breaks the tie correctly among rows sharing an IDENTICAL created_at, independent of group boundaries", async () => {
    const threadId = await makeThread(principalA);
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    // All 10 rows share one created_at — only `id` (insertion order,
    // UUIDv7-monotonic) can determine both selection and ordering here.
    const specs = Array.from({ length: 10 }, (_, i) => ({ content: `message-${i}`, createdAt: sameInstant }));
    await insertRawMessages(threadId, specs);

    const recent = await listRecentMessages(t.db, principalA, threadId, 4);
    expect(recent.map((m) => m.content)).toEqual(["message-6", "message-7", "message-8", "message-9"]);
  });

  it("caps an excessive requested limit at MAX_RECENT_MESSAGES_LIMIT", async () => {
    const threadId = await makeThread(principalA);
    const baseTime = new Date("2026-01-01T00:00:00.000Z");
    const total = MAX_RECENT_MESSAGES_LIMIT + 5;
    const specs = Array.from({ length: total }, (_, i) => ({
      content: `message-${i}`,
      createdAt: new Date(baseTime.getTime() + i * 1000),
    }));
    await insertRawMessages(threadId, specs);

    const result = await listRecentMessages(t.db, principalA, threadId, 1_000_000);
    expect(result).toHaveLength(MAX_RECENT_MESSAGES_LIMIT);
    // Still the newest ones, in chronological order.
    expect(result[result.length - 1].content).toBe(`message-${total - 1}`);
    expect(result[0].content).toBe(`message-${total - MAX_RECENT_MESSAGES_LIMIT}`);
  });

  it("limit 0 returns an empty array, not an unbounded/negative-LIMIT query", async () => {
    const threadId = await makeThread(principalA);
    await insertRawMessages(threadId, [{ content: "only", createdAt: new Date() }]);
    expect(await listRecentMessages(t.db, principalA, threadId, 0)).toEqual([]);
  });

  it("a non-finite limit (NaN/Infinity) returns an empty array rather than failing open to an unbounded query", async () => {
    const threadId = await makeThread(principalA);
    await insertRawMessages(threadId, [{ content: "only", createdAt: new Date() }]);
    expect(await listRecentMessages(t.db, principalA, threadId, NaN)).toEqual([]);
    expect(await listRecentMessages(t.db, principalA, threadId, Infinity)).toEqual([]);
  });
});

describe("listRecentMessages — IDOR", () => {
  it("a foreign principal gets NOT_FOUND listing another user's thread messages", async () => {
    const threadId = await makeThread(principalA);
    await insertRawMessages(threadId, [{ content: "secret", createdAt: new Date() }]);
    await expect(listRecentMessages(t.db, principalB, threadId, 10)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a missing thread id gets NOT_FOUND, identically to a foreign one", async () => {
    await expect(
      listRecentMessages(t.db, principalA, "99999999-9999-9999-9999-999999999999", 10),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("appendMessage", () => {
  it("the owning principal can append a user message (positive control)", async () => {
    const threadId = await makeThread(principalA);
    const message = await appendMessage(t.db, principalA, threadId, { role: "user", content: "Hello" });
    expect(message.role).toBe("user");
    expect(message.mode).toBeNull();
    expect(message.modelUsed).toBeNull();
  });

  it("persists an assistant message's routedDomains as a text[] column", async () => {
    const threadId = await makeThread(principalA);
    const message = await appendMessage(t.db, principalA, threadId, {
      role: "assistant",
      content: "Here's your answer",
      mode: "grounded",
      modelUsed: "gemini-2.5-pro",
      routedDomains: ["tenancy", "employment"],
    });
    expect(message.routedDomainArray).toEqual(["tenancy", "employment"]);
    expect(message.mode).toBe("grounded");
    expect(message.modelUsed).toBe("gemini-2.5-pro");

    const [reloaded] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
    expect(reloaded.routedDomainArray).toEqual(["tenancy", "employment"]);
  });

  it("generates the id via the UUIDv7 helper (passes the DB's messages_id_uuidv7_check)", async () => {
    const threadId = await makeThread(principalA);
    const message = await appendMessage(t.db, principalA, threadId, { role: "user", content: "Hi" });
    // The DB CHECK (substr(id::text, 15, 1) = '7') already enforces this at
    // insert time — reaching this line without the insert throwing is itself
    // the meaningful assertion. Assert on the version nibble directly too.
    expect(message.id.charAt(14)).toBe("7");
  });

  it("IDOR: a foreign principal cannot append to another user's thread, and nothing is inserted", async () => {
    const threadId = await makeThread(principalA);
    await expect(
      appendMessage(t.db, principalB, threadId, { role: "user", content: "Hijack" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const rows = await t.db.select().from(schema.messages).where(eq(schema.messages.threadId, threadId));
    expect(rows).toHaveLength(0);
  });

  it("IDOR: appending to a missing thread throws NOT_FOUND, identically to a foreign one", async () => {
    await expect(
      appendMessage(t.db, principalA, "99999999-9999-9999-9999-999999999999", { role: "user", content: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // appendMessage must bump the thread's updated_at so listThreads' recency ordering reflects real
  // activity, not just create/rename.
  it("bumps the thread's updated_at on a successful append", async () => {
    const threadId = await makeThread(principalA);
    const [before] = await t.db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    await new Promise((resolve) => setTimeout(resolve, 5)); // ensure a measurable clock delta
    await appendMessage(t.db, principalA, threadId, { role: "user", content: "hi" });
    const [after] = await t.db.select().from(schema.threads).where(eq(schema.threads.id, threadId));
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  // A thread deleted in the narrow window between appendMessage's own getThread() check and its
  // INSERT (a genuine concurrent-request race, not an IDOR) makes the INSERT fail a foreign-key
  // constraint — that must surface as the same NOT_FOUND every disappearing-thread path produces.
  it("a thread deleted concurrently with appendMessage's INSERT returns NOT_FOUND, never an unhandled FK-violation error", async () => {
    const threadId = await makeThread(principalA);
    const [appendResult] = await Promise.allSettled([
      appendMessage(t.db, principalA, threadId, { role: "user", content: "hi" }),
      t.db.delete(schema.threads).where(eq(schema.threads.id, threadId)),
    ]);
    expect(appendResult.status).toBe("rejected");
    if (appendResult.status === "rejected") {
      expect(appendResult.reason).toMatchObject({ code: "NOT_FOUND" });
    }
  });
});
