/**
 * Client-side guest thread store: a guest's active conversation has no database row — it lives as a
 * JSON blob the client owns, via an injected StorageBackend (never touched directly). A citation held
 * here was either generated client-side or is whatever the server last sent, never re-verified —
 * `unverifiedCachedStatus` must never be rendered as a trust signal.
 */

/** Who sent a guest chat message. */
export type GuestMessageRole = "user" | "assistant";
/** A chat message's mode: grounded in an attached document, or general legal chat. */
export type GuestMessageMode = "grounded" | "general";

/**
 * Deliberately a disjoint literal union from the server's `VerificationStatus`, sharing no member, so
 * a component can never accidentally accept this cached status as if it were verify()'s own trusted
 * result. Only `toUnverifiedCachedStatus` below produces one.
 */
export type UnverifiedCachedStatus = "cached_verified" | "cached_approximate" | "cached_not_found";

const CACHED_STATUS_BY_RAW: Record<"verified" | "approximate" | "not_found", UnverifiedCachedStatus> = {
  verified: "cached_verified",
  approximate: "cached_approximate",
  not_found: "cached_not_found",
};

/** Maps a server verification status to its never-a-trust-signal, cache-only counterpart. */
export function toUnverifiedCachedStatus(raw: "verified" | "approximate" | "not_found"): UnverifiedCachedStatus {
  return CACHED_STATUS_BY_RAW[raw];
}

/** A citation as cached in a guest thread. */
export interface GuestThreadCitation {
  quoteText: string;
  sourceDocumentId: string;
  // Never rendered directly as a trust signal (see module header). Deliberately not named
  // `verificationStatus`/`status`, so it can't be mistaken for the server's own trusted audit field,
  // and its type can't even structurally match that field's.
  unverifiedCachedStatus: UnverifiedCachedStatus;
}

/** A chat message as stored client-side. */
export interface GuestMessage {
  id: string;
  role: GuestMessageRole;
  content: string;
  mode: GuestMessageMode | null;
  citations: GuestThreadCitation[];
  // Date.now() at append time. Not a substitute for a real ordering key — the array's own append
  // order is authoritative; this field is for display only (e.g. relative timestamps).
  createdAtMs: number;
}

/** A guest's whole conversation, as it round-trips through storage. */
export interface GuestThread {
  // Client-generated (e.g. crypto.randomUUID()) — never a server id, since no DB row exists to have
  // minted one.
  id: string;
  title: string;
  documentIds: string[];
  messages: GuestMessage[];
}

/** The storage backend a caller injects, matching the subset of the browser's Web Storage API this module needs; never imported directly. */
export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Builds a fresh, empty thread with the given id. */
export function createEmptyThread(id: string, title = "New thread"): GuestThread {
  return { id, title, documentIds: [], messages: [] };
}

/** Append-only: returns a new thread with the message appended at the end. Never mutates `thread` or reorders/removes an existing message. */
export function appendMessage(thread: GuestThread, message: GuestMessage): GuestThread {
  return { ...thread, messages: [...thread.messages, message] };
}

/**
 * Returns the last `n` messages in chronological order — the same contract listRecentMessages
 * enforces server-side. `n` is clamped to [0, messages.length]; Number.isFinite guards NaN/±Infinity,
 * since `slice(NaN)` would otherwise silently return the whole array.
 */
export function recentMessages(thread: GuestThread, n: number): GuestMessage[] {
  if (!Number.isFinite(n)) return [];
  const count = Math.max(0, Math.min(Math.trunc(n), thread.messages.length));
  if (count === 0) return [];
  return thread.messages.slice(thread.messages.length - count);
}

/** Conservative default, well under every browser's ~5-10MB storage quota; shared by the serialize and deserialize caps below. */
export const DEFAULT_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

// Sane maxima enforced before the message-dropping logic below — without this cap, one pathological
// field (e.g. a multi-megabyte title) makes that loop drop every message and still exceed maxBytes,
// silently reloading an empty thread next time.
const MAX_TITLE_LENGTH = 500;
const MAX_DOCUMENT_IDS = 100;

function boundedTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title;
}
function boundedDocumentIds(ids: string[]): string[] {
  return ids.length > MAX_DOCUMENT_IDS ? ids.slice(ids.length - MAX_DOCUMENT_IDS) : ids;
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Serializes with a hard size cap: if the JSON would exceed `maxBytes`, the oldest messages are
 * dropped until it fits, never the newest. The number to drop is computed exactly via suffix sums of
 * each message's own byte length, not estimated by average size, which over-drops when message sizes
 * are skewed (e.g. one huge old message among many tiny recent ones).
 */
export function serializeThread(thread: GuestThread, maxBytes: number = DEFAULT_MAX_SERIALIZED_BYTES): string {
  const bounded: GuestThread = {
    ...thread,
    title: boundedTitle(thread.title),
    documentIds: boundedDocumentIds(thread.documentIds),
  };

  const envelopeBytes = utf8ByteLength(JSON.stringify({ ...bounded, messages: [] }));
  const messages = bounded.messages;
  const messageBytes = messages.map((m) => utf8ByteLength(JSON.stringify(m)));

  // suffixSum[k] = total bytes of messages[k..end]'s own JSON, no separators.
  const suffixSum = new Array<number>(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= 0; i--) suffixSum[i] = suffixSum[i + 1] + messageBytes[i];

  // Exact total if messages[k..end] are kept: the envelope already counts the empty `"messages":[]`'s
  // 2 bracket bytes; a non-empty array replaces those same 2 bytes with `[` + content + `]`, adding
  // the kept messages' own bytes plus one comma per gap between them.
  function totalBytesKeepingFrom(k: number): number {
    const count = messages.length - k;
    if (count <= 0) return envelopeBytes;
    return envelopeBytes + suffixSum[k] + (count - 1);
  }

  let k = 0;
  while (k < messages.length && totalBytesKeepingFrom(k) > maxBytes) k++;

  return JSON.stringify({ ...bounded, messages: messages.slice(k) });
}

function isGuestThreadCitation(value: unknown): value is GuestThreadCitation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.quoteText === "string" &&
    typeof v.sourceDocumentId === "string" &&
    (v.unverifiedCachedStatus === "cached_verified" ||
      v.unverifiedCachedStatus === "cached_approximate" ||
      v.unverifiedCachedStatus === "cached_not_found")
  );
}

function isGuestMessage(value: unknown): value is GuestMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.role === "user" || v.role === "assistant") &&
    typeof v.content === "string" &&
    (v.mode === null || v.mode === "grounded" || v.mode === "general") &&
    Array.isArray(v.citations) &&
    v.citations.every(isGuestThreadCitation) &&
    typeof v.createdAtMs === "number"
  );
}

function isGuestThread(value: unknown): value is GuestThread {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    Array.isArray(v.documentIds) &&
    v.documentIds.every((d) => typeof d === "string") &&
    Array.isArray(v.messages) &&
    v.messages.every(isGuestMessage)
  );
}

// Rebuilds a thread from only the fields the type guards above validated: structural typing doesn't
// forbid extra properties surviving validation, so returning the parsed value as-is would let a
// devtools-forged field (e.g. a top-level `status: "verified"`) round-trip through storage untouched.
function sanitizeCitation(c: GuestThreadCitation): GuestThreadCitation {
  return { quoteText: c.quoteText, sourceDocumentId: c.sourceDocumentId, unverifiedCachedStatus: c.unverifiedCachedStatus };
}
function sanitizeMessage(m: GuestMessage): GuestMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    mode: m.mode,
    citations: m.citations.map(sanitizeCitation),
    createdAtMs: m.createdAtMs,
  };
}
function sanitizeGuestThread(t: GuestThread): GuestThread {
  return { id: t.id, title: t.title, documentIds: [...t.documentIds], messages: t.messages.map(sanitizeMessage) };
}

/**
 * Never throws. Corrupt, malformed, non-JSON, or oversized input (or `null`, meaning nothing stored)
 * returns a fresh empty thread instead of crashing or silently coercing. The size check runs before
 * `JSON.parse`, so an oversized corrupt blob never even reaches the parser.
 */
export function deserializeThread(
  raw: string | null,
  fallbackId: string,
  maxBytes: number = DEFAULT_MAX_SERIALIZED_BYTES,
): GuestThread {
  if (raw === null) return createEmptyThread(fallbackId);
  if (utf8ByteLength(raw) > maxBytes) return createEmptyThread(fallbackId);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isGuestThread(parsed)) return createEmptyThread(fallbackId);
    return sanitizeGuestThread(parsed);
  } catch {
    return createEmptyThread(fallbackId);
  }
}

/** Loads and deserializes the thread stored under `key`, or an empty thread if none exists. */
export function loadThread(backend: StorageBackend, key: string, maxBytes?: number): GuestThread {
  return deserializeThread(backend.getItem(key), key, maxBytes);
}

/** Serializes `thread` and writes it under `key`. */
export function saveThread(backend: StorageBackend, key: string, thread: GuestThread, maxBytes?: number): void {
  backend.setItem(key, serializeThread(thread, maxBytes));
}
