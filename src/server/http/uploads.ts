/**
 * The local half of the upload flow: a server-relay target has no upload URL of its own, so the
 * response points the client at a signed, expiring token for exactly the ref it minted. The relay
 * accepts a write only with a token this server signed within the last 15 minutes, and takes the
 * ref from the verified token — an unsigned, expired or tampered token is the same 404 as a
 * foreign ref, before any byte is written.
 */

import { createHmac } from "node:crypto";
import { getContainer } from "@/server/container";
import { notFound } from "@/server/core/errors";
import { MAX_UPLOAD_SIZE_BYTES } from "@/server/storage/policy";
import { signLocalUrl, verifyLocalUrl } from "@/server/storage/signed-url";
import type { CreateUploadTargetResult } from "@/server/storage/types";

/** Path the local relay target's upload URL is built against. */
export const UPLOAD_RELAY_PATH = "/api/uploads/relay";
/** How long a minted relay token stays valid. */
export const RELAY_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Body-size cap the relay route enforces before buffering a PUT, mirroring the storage adapter's own limit. */
export const MAX_RELAY_UPLOAD_BYTES = MAX_UPLOAD_SIZE_BYTES;

// Scoped to this one purpose: the storage adapter signs (ref, expiry) with the same function and
// secret for its own download URLs, and one of those must never pass as an upload token.
function relayKey(): string {
  return createHmac("sha256", getContainer().localStorageSigningSecret()).update("upload-relay/v1").digest("hex");
}

/** Builds the signed relay URL for one ref, expiring at `expiresAtMs`. */
export function relayUploadUrl(ref: string, expiresAtMs: number): string {
  return `${UPLOAD_RELAY_PATH}?token=${encodeURIComponent(signLocalUrl(relayKey(), ref, expiresAtMs))}`;
}

/** Rewrites a server-relay target's URL to the signed relay endpoint; a direct-put target passes through unchanged. */
export function withRelayUrl(target: CreateUploadTargetResult): CreateUploadTargetResult {
  if (target.method !== "server-relay") return target;
  return { ...target, uploadUrl: relayUploadUrl(target.ref, Date.now() + RELAY_TOKEN_TTL_MS) };
}

/** The ref a relay token grants; throws NOT_FOUND for a token this server did not sign, or an expired one. */
export function verifyRelayToken(token: string): string {
  const verified = verifyLocalUrl(relayKey(), token);
  if (!verified) throw notFound();
  return verified.ref;
}
