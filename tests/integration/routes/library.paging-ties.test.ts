// Mutation-proven equal-timestamp keyset paging tests for comparisons and threads — mirrors
// library.idor.test.ts's own "pages by updatedAt and id without repeats" test for documents and
// drafts (tests/architecture/library-paging.test.ts pins the shared query-bound machinery all four
// lists go through server-side; this file proves the observable behaviour at the route level for
// the two lists documents/drafts' own coverage didn't already reach).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import * as comparisons from "@/app/api/comparisons/route";
import * as threads from "@/app/api/threads/route";
import { insertComparison, insertDocument } from "@tests/support/auth/claim";
import { callRoute, createRouteHarness, request, userA, type RouteHarness } from "./harness";

let h: RouteHarness;
beforeEach(async () => {
  h = await createRouteHarness();
  h.signIn(userA);
});
afterEach(async () => {
  await h.close();
});

const get = (handler: Parameters<typeof callRoute>[0], path: string) => callRoute(handler, request("GET", path), {});

describe("comparisons: pages by updatedAt and id without repeats", () => {
  it("ties every row on the exact same updatedAt and still returns each row exactly once, in stable id order", async () => {
    const docs = await Promise.all(Array.from({ length: 6 }, () => insertDocument(h.t, userA, null)));
    const rows = await Promise.all([
      insertComparison(h.t, userA, docs[0].id, docs[1].id, null),
      insertComparison(h.t, userA, docs[2].id, docs[3].id, null),
      insertComparison(h.t, userA, docs[4].id, docs[5].id, null),
    ]);
    const instant = new Date("2026-09-24T12:00:00Z");
    await h.t.db.update(schema.comparisons).set({ updatedAt: instant }).where(eq(schema.comparisons.ownerUserId, userA.userId));

    const first = await (await get(comparisons.GET, "/api/comparisons?limit=2")).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await (await get(comparisons.GET, `/api/comparisons?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seenIds = [...first.items, ...second.items].map((r: { id: string }) => r.id);
    expect(new Set(seenIds)).toEqual(new Set(rows.map((r) => r.id)));
    expect(new Set(seenIds).size).toBe(seenIds.length); // no repeats across pages

    // The tiebreak is id-desc for equal updatedAt values — the same page boundary walked one at a
    // time must reproduce the identical order the two-page walk above already established.
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const body: { items: { id: string }[]; nextCursor: string | null } = await (
        await get(comparisons.GET, `/api/comparisons?limit=1${suffix}`)
      ).json();
      walked.push(...body.items.map((r) => r.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(walked).toEqual(seenIds);
  });
});

describe("threads: pages by updatedAt and id without repeats", () => {
  it("ties every row on the exact same updatedAt and still returns each row exactly once, in stable id order", async () => {
    const rows = await h.t.db
      .insert(schema.threads)
      .values([
        { ownerUserId: userA.userId, title: "Thread A" },
        { ownerUserId: userA.userId, title: "Thread B" },
        { ownerUserId: userA.userId, title: "Thread C" },
      ])
      .returning();
    const instant = new Date("2026-09-24T12:00:00Z");
    await h.t.db.update(schema.threads).set({ updatedAt: instant }).where(eq(schema.threads.ownerUserId, userA.userId));

    const first = await (await get(threads.GET, "/api/threads?limit=2")).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await (await get(threads.GET, `/api/threads?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seenIds = [...first.items, ...second.items].map((r: { id: string }) => r.id);
    expect(new Set(seenIds)).toEqual(new Set(rows.map((r) => r.id)));
    expect(new Set(seenIds).size).toBe(seenIds.length);

    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const body: { items: { id: string }[]; nextCursor: string | null } = await (
        await get(threads.GET, `/api/threads?limit=1${suffix}`)
      ).json();
      walked.push(...body.items.map((r) => r.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(walked).toEqual(seenIds);
  });
});
