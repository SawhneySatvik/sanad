import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/server/data/library.ts", "utf8");

describe("library query bounds", () => {
  it("bounds document, comparison, thread, and draft-chain fetches before rows reach the service", () => {
    const ordinary = source.slice(source.indexOf("export async function listLibraryRows"), source.indexOf("export async function listDraftChainsPage"));
    const draft = source.slice(source.indexOf("export async function listDraftChainsPage"), source.indexOf("export async function getLibraryRow"));
    expect(ordinary.match(/\.limit\(limit \+ 1\)/g)).toHaveLength(3);
    expect(draft).toContain("ORDER BY updated_at DESC, id DESC LIMIT ${limit + 1}");
  });
});

describe("library service data access", () => {
  it("reads documents and analyses only through principal-taking repository functions", () => {
    const service = readFileSync("src/server/services/library.ts", "utf8");
    expect(service).not.toMatch(/deps\.db\.(select|insert|update|delete|execute|transaction)/);
    expect(service).not.toMatch(/schema\.(documents|analyses)\b/);
  });
});
