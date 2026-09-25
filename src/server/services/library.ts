import type { ServiceDeps } from "../container";
import * as schema from "../../db/schema";
import type { Principal } from "../core/types";
import * as repository from "../data/library";
import type { DocumentSummary } from "../data/documents";
import { AppError } from "../core/errors";
import { isUuidShaped } from "../data/documents";
import { DOCUMENT_TYPE_REGISTRY } from "../deterministic/document-type-registry";

type Kind = repository.LibraryKind;
type ListedKind = Exclude<Kind, "project">;
type ListOptions = { cursor?: string; limit?: number };

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function parseCursor(cursorValue: string | undefined): repository.LibraryCursor | null {
  let cursor: repository.LibraryCursor | null = null;
  if (cursorValue) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8"));
      if (Array.isArray(decoded) && decoded.length === 2) {
        const [updatedAt, id] = decoded;
        if (typeof updatedAt === "string" && CURSOR_TIMESTAMP.test(updatedAt) && calendarValidTimestamp(updatedAt) &&
          typeof id === "string" && isUuidShaped(id)) cursor = { updatedAt, id };
      }
    } catch { /* malformed cursors share the validation response */ }
    if (!cursor) throw new AppError("VALIDATION_FAILED", "Invalid cursor.");
  }
  return cursor;
}

function calendarValidTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  // Postgres rejects year 0 and offsets past ±15:59 with a server error, so they must fail here as a 400.
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== "Z") {
    const parts = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(zone);
    if (!parts || Number(parts[2]) > 15 || Number(parts[3] ?? 0) > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function pageRows<T extends { id: string; cursorUpdatedAt: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursorUpdatedAt, last.id])).toString("base64url") : null };
}

function draftTitle(row: { title: string | null; documentType: string }): string {
  return row.title ?? `${DOCUMENT_TYPE_REGISTRY.find((entry) => entry.id === row.documentType)?.label ?? row.documentType} draft`;
}

function documentRow(row: DocumentSummary, analyzed: boolean) {
  return { id: row.id, title: row.title ?? row.filename, filename: row.filename, documentType: row.documentType,
    processingStatus: row.processingStatus, analysisState: analyzed ? "complete" as const : "not_analyzed" as const,
    inputMode: row.inputMode, sampleId: row.sampleId, projectId: row.projectId, uploadedAt: row.uploadedAt,
    updatedAt: row.updatedAt, expiresAt: row.expiresAt };
}

function comparisonRow(row: typeof schema.comparisons.$inferSelect, titleA: string, titleB: string) {
  return { id: row.id, title: row.title ?? `${titleA} vs ${titleB}`, titleA, titleB, documentAId: row.documentAId,
    documentBId: row.documentBId, modelUsed: row.modelUsed, projectId: row.projectId, createdAt: row.createdAt,
    updatedAt: row.updatedAt, expiresAt: row.expiresAt };
}

function draftRow(row: typeof schema.drafts.$inferSelect, revisionCount: number) {
  return { id: row.id, title: draftTitle(row), documentType: row.documentType, mode: row.mode,
    revisionCount, projectId: row.projectId, createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: row.expiresAt };
}

function threadRow(row: typeof schema.threads.$inferSelect) {
  return { id: row.id, title: row.title, projectId: row.projectId, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function projectRow(row: typeof schema.projects.$inferSelect) {
  return { id: row.id, name: row.name, color: row.color, icon: row.icon,
    openedAt: row.openedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

async function mappedRow(deps: ServiceDeps, principal: Principal, kind: ListedKind, id: string) {
  const row = await repository.getLibraryRow(deps.db, principal, kind, id);
  if (kind === "document" && "filename" in row) {
    return documentRow(row, (await repository.analyzedDocumentIds(deps.db, principal, [id])).has(id));
  }
  if (kind === "comparison" && "documentAId" in row) {
    const names = await repository.documentTitles(deps.db, principal, [row.documentAId, row.documentBId]);
    return comparisonRow(row, names.get(row.documentAId) ?? "Document A", names.get(row.documentBId) ?? "Document B");
  }
  if (kind === "draft" && "revisionNumber" in row) {
    const chain = await repository.draftChain(deps.db, principal, id);
    return draftRow(row, chain.length);
  }
  if (kind === "thread" && "ownerUserId" in row && "title" in row) return threadRow(row as typeof schema.threads.$inferSelect);
  throw new Error("Unexpected library row.");
}

export async function list(deps: ServiceDeps, principal: Principal, kind: ListedKind, options: ListOptions) {
  const cursor = parseCursor(options.cursor);
  const limit = options.limit ?? 20;
  if (kind === "draft") {
    const entries = await repository.listDraftChainsPage(deps.db, principal, cursor, limit);
    const page = pageRows(entries.map((entry) => ({ ...entry, id: entry.row.id })), limit);
    return { items: page.items.map((entry) => draftRow(entry.row, entry.revisionCount)), nextCursor: page.nextCursor };
  }
  const rows = await repository.listLibraryRows(deps.db, principal, kind, cursor, limit);
  const page = pageRows(rows as { id: string; cursorUpdatedAt: string }[], limit);
  if (kind === "document") {
    const docs = page.items as unknown as DocumentSummary[];
    const analyzed = await repository.analyzedDocumentIds(deps.db, principal, docs.map((row) => row.id));
    return { items: docs.map((row) => documentRow(row, analyzed.has(row.id))), nextCursor: page.nextCursor };
  }
  if (kind === "comparison") {
    const comparisons = page.items as unknown as (typeof schema.comparisons.$inferSelect)[];
    const names = await repository.documentTitles(deps.db, principal, comparisons.flatMap((row) => [row.documentAId, row.documentBId]));
    return { items: comparisons.map((row) => comparisonRow(row, names.get(row.documentAId) ?? "Document A", names.get(row.documentBId) ?? "Document B")), nextCursor: page.nextCursor };
  }
  return { items: (page.items as unknown as (typeof schema.threads.$inferSelect)[]).map(threadRow), nextCursor: page.nextCursor };
}

export async function rename(deps: ServiceDeps, principal: Principal, kind: Kind, id: string, value: string) {
  const row = await repository.renameLibraryRow(deps.db, principal, kind, id, value);
  return kind === "project" ? projectRow(row as typeof schema.projects.$inferSelect) : mappedRow(deps, principal, kind, id);
}

export async function unassign(deps: ServiceDeps, principal: Principal, kind: ListedKind, id: string) {
  await repository.unassignLibraryRow(deps.db, principal, kind, id);
  return mappedRow(deps, principal, kind, id);
}

export async function remove(deps: ServiceDeps, principal: Principal, kind: Kind, id: string) {
  const row = await repository.deleteLibraryRow(deps.db, principal, kind, id);
  if (kind === "document" && "storageRef" in row) {
    await deleteQueuedObject(deps, principal, row);
  }
}

async function deleteQueuedObject(deps: ServiceDeps, principal: Principal, row: DocumentSummary) {
  try {
    const result = await repository.processQueuedStorageRef(deps.db, row.storageRef, () => deps.storage.delete(principal, row));
    if (result === "failed") console.error("Document object deletion deferred to purger.");
  } catch { console.error("Document object deletion deferred to purger."); }
}

export async function deleteImpact(deps: ServiceDeps, principal: Principal, id: string) {
  return repository.documentDeleteImpact(deps.db, principal, id);
}

export async function revisions(deps: ServiceDeps, principal: Principal, id: string) {
  const chain = await repository.draftChain(deps.db, principal, id);
  const latest = chain.at(-1)?.id;
  return { items: chain.map((row) => ({ id: row.id, parentDraftId: row.parentDraftId, revisionNumber: row.revisionNumber,
    createdAt: row.createdAt, modelUsed: row.modelUsed, userInstructions: row.userInstructions,
    isCurrent: row.id === id, isLatest: row.id === latest })) };
}

export async function deleteAll(deps: ServiceDeps, principal: Principal) {
  const result = await repository.deleteAllLibraryRows(deps.db, principal);
  for (const row of result.storageRows) {
    await deleteQueuedObject(deps, principal, row);
  }
  return { deleted: result.deleted };
}
