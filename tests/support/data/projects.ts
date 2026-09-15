// Shared setup for the projects repository tests. Principals, users and `caught` come from
// tests/support/data/documents.ts (read-only); row fixtures from the claim tests' support file,
// which inserts straight through the schema rather than through the other repositories directly.

import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";

export { caught, createRepoTestDb as createProjectsTestDb, guestA, guestB, userA, userB, USER_A_ID, USER_B_ID } from "@tests/support/data/documents";
export { insertComparison, insertDocument, insertDraftChain } from "@tests/support/auth/claim";

/** An `expiresAt` value for fixtures that need a not-yet-expired row. */
export function inAnHour(): Date {
  return new Date(Date.now() + 3_600_000);
}

/** Inserts a user-owned thread row directly through the schema, bypassing the repository. */
export async function insertThread(t: TestDb, ownerUserId: string) {
  const [row] = await t.db.insert(schema.threads).values({ ownerUserId, title: "chat" }).returning();
  return row;
}
