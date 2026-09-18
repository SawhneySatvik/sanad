import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Db } from "@/db/client";
import { getDocument } from "@/server/data/documents";
import type { TestDb } from "@tests/support/db";
import { caught, createRepoTestDb, guestA, guestB, readyDocument, userA, userB } from "@tests/support/data/documents";

// A foreign id must never select another principal's canonical_text: that read's cost depends on
// the other document's size, so it would time differently from a missing id. Observed on the real
// database through a query logger — the SQL each call actually sends, not a mock.

let t: TestDb;
let queries: string[];
let logged: Db;
beforeEach(async () => {
  t = await createRepoTestDb();
  queries = [];
  logged = drizzle(t.client, { schema, logger: { logQuery: (query) => queries.push(query) } });
});
afterEach(async () => {
  await t.close();
});

// Quoted column token: "canonical_text" but not "canonical_text_hash".
const selectsCanonicalText = (sql: string) => /"canonical_text"/.test(sql);

describe("getDocument — a foreign row's canonical_text is never selected", () => {
  it.each([
    ["user", userA, userB],
    ["guest", guestA, guestB],
    ["user against guest", guestA, userA],
  ])("%s: the owner's read selects the text; a foreign read is NOT_FOUND without selecting it", async (_, owner, other) => {
    const document = await readyDocument(t, owner, "x".repeat(200_000));

    queries = [];
    const own = await getDocument(logged, owner, document.id);
    expect(own.canonicalText).toBe("x".repeat(200_000));
    expect(queries.some(selectsCanonicalText)).toBe(true);

    queries = [];
    expect((await caught(getDocument(logged, other, document.id))).code).toBe("NOT_FOUND");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.filter(selectsCanonicalText)).toEqual([]);
  });

  it("a missing id and a malformed id are NOT_FOUND the same way", async () => {
    expect((await caught(getDocument(logged, userA, "11111111-1111-4111-8111-111111111111"))).code).toBe("NOT_FOUND");
    expect(queries.filter(selectsCanonicalText)).toEqual([]);
    expect((await caught(getDocument(logged, userA, "not-a-uuid"))).code).toBe("NOT_FOUND");
  });
});
