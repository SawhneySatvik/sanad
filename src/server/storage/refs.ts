/**
 * Storage ref namespacing: `{principalKey}/{uuid}/{sanitizedFilename}`. `ref` values arriving at
 * confirmUpload are client-supplied — the client/route handler echoes back the ref it was given —
 * and must be parsed as hostile input; parseRef() is intentionally strict, not just a `.split("/")`.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { AppError } from "../core/errors";
import type { Principal } from "../core/types";

const SAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]/g;
const ALL_DOTS = /^\.+$/;
const MAX_FILENAME_LENGTH = 200;
const FALLBACK_FILENAME = "file";

// Principal ids are server-minted but that doesn't make them path-safe by construction — a guest
// session id containing "/" would silently split a ref into the wrong number of segments.
//
// Lowercase only, deliberately: case-insensitive filesystems (APFS default, exFAT, NTFS) can resolve
// "user:ABC/..." and "user:abc/..." to the same object while they're different, case-sensitive
// `storage_ref` strings in Postgres. One canonical casing closes that alias gap.
const SAFE_ID_CHARS = /^[a-z0-9_-]+$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function malformedRef(ref: string): AppError {
  return new AppError("VALIDATION_FAILED", `Malformed storage ref: ${ref}`);
}

/** The ref's principal segment: `user:<id>` or `guest:<id>`. */
export function principalKey(principal: Principal): string {
  const id = principal.type === "user" ? principal.userId : principal.guestSessionId;
  if (!SAFE_ID_CHARS.test(id)) {
    // Surfaces loudly rather than silently mis-namespacing a ref — if this ever fires, session.ts or
    // user creation is producing ids with characters outside [A-Za-z0-9_-], which this module's ref
    // format cannot safely carry as a single path segment.
    throw new AppError(
      "VALIDATION_FAILED",
      `Principal id contains characters unsafe for a storage ref segment: ${id}`,
    );
  }
  return principal.type === "user" ? `user:${id}` : `guest:${id}`;
}

/**
 * Sanitizes by transformation, never by outright rejection: the ref it produces just needs to never
 * let a write escape the storage root. Allowlist approach — keeps only [A-Za-z0-9._-], replacing
 * everything else (path separators, NUL, unicode, control chars, spaces) with "_". A resulting
 * all-dots name (".", "..", "...") is still a traversal-capable path segment even with no separator
 * characters left in it, so that case is caught explicitly.
 */
export function sanitizeFilename(filename: string): string {
  const stripped = filename.replace(SAFE_FILENAME_CHARS, "_").slice(0, MAX_FILENAME_LENGTH);
  if (stripped.length === 0 || ALL_DOTS.test(stripped)) {
    return FALLBACK_FILENAME;
  }
  return stripped;
}

/** Mints a fresh, unclaimed storage ref for `principal` and `filename`. */
export function buildRef(principal: Principal, filename: string): string {
  return `${principalKey(principal)}/${randomUUID()}/${sanitizeFilename(filename)}`;
}

/** The three segments of a storage ref, after parseRef validates it. */
export interface ParsedRef {
  principalKey: string;
  uuid: string;
  filename: string;
}

/**
 * Strict on purpose: a ref reaching here at confirmUpload time is client-supplied, so this is real
 * input validation, not just structure-extraction of a value this module already trusts.
 * @throws AppError VALIDATION_FAILED if `ref` doesn't match the exact 3-segment grammar.
 */
export function parseRef(ref: string): ParsedRef {
  const parts = ref.split("/");
  if (parts.length !== 3) {
    throw malformedRef(ref);
  }
  const [key, uuid, filename] = parts;
  // Lowercase-only (see SAFE_ID_CHARS above) — an uppercase/mixed-case
  // "alias" of a valid key is rejected outright, never silently accepted.
  if (!/^(user|guest):[a-z0-9_-]+$/.test(key)) {
    throw malformedRef(ref);
  }
  if (!UUID_RE.test(uuid)) {
    throw malformedRef(ref);
  }
  if (filename.length === 0 || filename !== sanitizeFilename(filename)) {
    throw malformedRef(ref);
  }
  return { principalKey: key, uuid, filename };
}

/** Whether `ref` belongs to `principal`, based on the ref's principal-key segment. */
export function refBelongsTo(ref: string, principal: Principal): boolean {
  return parseRef(ref).principalKey === principalKey(principal);
}

/**
 * Resolves a ref to an absolute on-disk path under `root`, refusing to return anything outside it.
 * Belt-and-suspenders on top of parseRef's strict grammar and sanitizeFilename's allowlist: even if
 * some future change loosened either of those, this containment check is the actual backstop that a
 * write/read can never escape the storage root.
 */
export function refToPath(root: string, ref: string): string {
  const parsed = parseRef(ref);
  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(resolvedRoot, parsed.principalKey, parsed.uuid, parsed.filename);
  // Given parseRef's current grammar — each of the 3 segments forbidden from containing "/" or
  // resolving to "." / ".." — this branch is intentionally-unreachable defense-in-depth: kept as the
  // actual backstop if parseRef's grammar is ever loosened later without this function being revisited.
  if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + path.sep)) {
    throw malformedRef(ref);
  }
  return fullPath;
}
