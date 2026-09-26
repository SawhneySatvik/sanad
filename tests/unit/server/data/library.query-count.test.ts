// draftChain() and listDraftChainsPage() must cost a fixed number of statements regardless of chain
// depth or page size — never one extra round trip per revision or per row on the page. A query
// logger over the real PGlite driver (the same technique documents.foreign-text.idor.test.ts uses)
// proves it, including the case where a page's chains carry project/grounding-document references
// (the checks the ranked SQL itself can't express). library.idor.test.ts covers the same batch path
// rejecting a chain whose reference turns foreign.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Db } from "@/db/client";
import { draftChain, listDraftChainsPage } from "@/server/data/library";
import { createClaimTestDb, insertDocument, insertDraftChain, user } from "@tests/support/auth/claim";
import type { TestDb } from "@tests/support/db";

let t: TestDb;
let logged: Db;
let queries: string[];

beforeEach(async () => {
  t = await createClaimTestDb();
  queries = [];
  logged = drizzle(t.client, { schema, logger: { logQuery: (query) => queries.push(query) } });
});
afterEach(async () => {
  await t.close();
});

describe("draftChain query count is independent of chain depth", () => {
  it("costs the same number of statements at a leaf of depth 2 as at a leaf of depth 6, and a root cheaper than either", async () => {
    const root = await insertDraftChain(t, user, null, null, 1);
    const shallow = await insertDraftChain(t, user, null, null, 2);
    const deep = await insertDraftChain(t, user, null, null, 6);

    queries = [];
    await draftChain(logged, user, root[0].id);
    const rootCount = queries.length;

    queries = [];
    await draftChain(logged, user, shallow.at(-1)!.id);
    const shallowCount = queries.length;

    queries = [];
    await draftChain(logged, user, deep.at(-1)!.id);
    const deepCount = queries.length;

    // A root revision is its own chain root, so it skips the ancestor walk chainRootId() needs for
    // anything deeper — one fewer query than any non-root id, whatever that id's actual depth.
    expect(rootCount).toBe(3);
    expect(shallowCount).toBe(4);
    expect(deepCount).toBe(4);
  });
});

describe("listDraftChainsPage query count is independent of page size", () => {
  it("costs the same number of statements for a 1-chain page as for a 10-chain page", async () => {
    for (let i = 0; i < 10; i++) await insertDraftChain(t, user, null, null, 2);

    queries = [];
    await listDraftChainsPage(logged, user, null, 1);
    const onePage = queries.length;
    // One query apiece for the ranked page, the id-only chain walk and the batch row select — no
    // per-entry draftChain() call.
    expect(onePage).toBe(3);

    queries = [];
    const tenPage = await listDraftChainsPage(logged, user, null, 10);
    expect(tenPage).toHaveLength(10);
    expect(queries.length).toBe(onePage);
  });

  it("costs the same fixed count even once every chain on the page carries a project and a grounding document", async () => {
    const [project] = await t.db.insert(schema.projects).values({ ownerUserId: user.userId, name: "Matter" }).returning();
    for (let i = 0; i < 10; i++) {
      const grounding = await insertDocument(t, user, null);
      const chain = await insertDraftChain(t, user, null, grounding.id, 2);
      await t.db.update(schema.drafts).set({ projectId: project.id }).where(eq(schema.drafts.ownerUserId, user.userId));
      void chain;
    }

    queries = [];
    await listDraftChainsPage(logged, user, null, 1);
    const onePage = queries.length;
    // One query apiece for the ranked page, the id-only chain walk, the batch row select, the batch
    // grounding-document lookup and the batch project lookup — fixed, whatever the page size.
    expect(onePage).toBe(5);

    queries = [];
    const tenPage = await listDraftChainsPage(logged, user, null, 10);
    expect(tenPage).toHaveLength(10);
    expect(queries.length).toBe(onePage);
  });
});
