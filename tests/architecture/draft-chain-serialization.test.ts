import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

it("draft chain writers share a root lock and refetch the chain after taking it", () => {
  const library = read("src/server/data/library.ts");
  const drafts = read("src/server/data/drafts.ts");
  const projects = read("src/server/data/projects.ts");
  const lock = library.slice(library.indexOf("export async function lockDraftChain"), library.indexOf("function cleanTitle"));
  expect(lock).toContain("pg_advisory_xact_lock");
  expect(lock).toContain("sweepOrderOfDrafts(chain)");
  const deleteAll = library.slice(library.indexOf("export async function deleteAllLibraryRows"));
  expect(deleteAll).toContain("sweepOrderOfDrafts(draftSnapshot)");
  expect((lock.match(/draftChain\(tx, principal, id\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect((library.match(/await lockDraftChain\(tx, principal, id\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect(drafts).toContain("await lockDraftChain(tx, principal, parent.id)");
  expect(projects).toContain("await lockDraftChain(tx, principal, item.id)");
});

it("delete-all locks the principal's projects before any item row or draft chain, matching saveToProject", () => {
  const library = read("src/server/data/library.ts");
  const projects = read("src/server/data/projects.ts");
  const deleteAll = library.slice(library.indexOf("export async function deleteAllLibraryRows"));
  const projectLock = deleteAll.indexOf("from(schema.projects)");
  expect(projectLock).toBeGreaterThan(-1);
  for (const later of ["pg_advisory_xact_lock", "from(schema.comparisons)", "from(schema.drafts)", "from(schema.documents)", "from(schema.threads)"]) {
    expect(deleteAll.indexOf(later), later).toBeGreaterThan(projectLock);
  }
  const save = projects.slice(projects.indexOf("export async function saveToProject"));
  expect(save.indexOf("from(schema.projects)")).toBeLessThan(save.indexOf("lockDraftChain(tx, principal, item.id)"));
  expect(save.indexOf("from(schema.projects)")).toBeLessThan(save.indexOf("lockItemRows(tx, item)"));
});
