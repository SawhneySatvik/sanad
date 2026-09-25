// GET /api/documents/:id/text through the real route wiring. Owner access itself is covered
// separately in document-text.idor.test.ts; this file covers the 2xx shape, the not-store/no-ETag/
// no-304 gate, the 422 document_not_ready gate, and that a native_document's transcription is never
// run through sanitizeModelText() — it must equal canonical_text byte-exact.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import * as documentTextRoute from "@/app/api/documents/[id]/text/route";
import { createPendingDocument, markDocumentExtractionFailed, markDocumentReady } from "@/server/data/documents";
import type { Principal } from "@/server/core/types";
import { refFor } from "@tests/support/data/documents";
import { DocumentTextOutput } from "@/shared/contracts/document-text";
import { analyzedDocumentViaRoutes, callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";

// The row's own stored hash, read independently of anything the route computed — a self-referential
// sha256(body.text) would pass even if a bug returned a coordinated wrong text/textHash pair.
async function storedCanonicalTextHash(documentId: string): Promise<string> {
  const [row] = await h.t.db
    .select({ canonicalTextHash: schema.documents.canonicalTextHash })
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!row?.canonicalTextHash) throw new Error("document has no stored canonical_text_hash");
  return row.canonicalTextHash;
}

let h: RouteHarness;
afterEach(async () => {
  await h.close();
});

function getText(id: string, cookie: string | null, headers?: Record<string, string>) {
  return callRoute(documentTextRoute.GET, request("GET", `/api/documents/${id}/text`, { cookie, headers }), { id });
}

async function pendingDoc(principal: Principal, filename = "pending.txt") {
  return createPendingDocument(h.t.db, principal, { storageRef: refFor(principal, filename), filename, mimeType: "text/plain" });
}

describe("GET /api/documents/:id/text", () => {
  it("returns the document's canonical text, hash and inputMode for its owner", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(cookie);

    const res = await getText(documentId, cookie);

    expect(res.status).toBe(200);
    const body = DocumentTextOutput.parse(await res.json());
    expect(body.documentId).toBe(documentId);
    expect(body.inputMode).toBe("text");
    expect(body.text.length).toBeGreaterThan(0);
    // Compared against the row's own stored hash, read independently — not derived from body.text.
    expect(body.textHash).toBe(await storedCanonicalTextHash(documentId));
  });

  it("Cache-Control: no-store, no ETag, and a stale If-None-Match never produces a 304", async () => {
    h = await createRouteHarness();
    const { cookie } = guestCookie();
    const documentId = await analyzedDocumentViaRoutes(cookie);

    const plain = await getText(documentId, cookie);
    expect(plain.headers.get("cache-control")).toBe("no-store");
    expect(plain.headers.get("etag")).toBeNull();

    const conditional = await getText(documentId, cookie, { "if-none-match": '"anything-at-all"' });
    expect(conditional.status).toBe(200);
    expect(conditional.headers.get("etag")).toBeNull();
    expect(conditional.headers.get("cache-control")).toBe("no-store");
  });

  it("422 INVALID_DOCUMENT / document_not_ready on the owner's own still-pending document, and leaks no text/textHash", async () => {
    h = await createRouteHarness();
    const guest = guestCookie();
    const principal: Principal = { type: "guest", guestSessionId: guest.guestSessionId };
    const doc = await pendingDoc(principal);

    const res = await getText(doc.id, guest.cookie);

    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ error: { code: "INVALID_DOCUMENT", message: expect.any(String), reason: "document_not_ready" } });
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/"text"\s*:/);
    expect(raw).not.toMatch(/"textHash"\s*:/);
  });

  it("422 INVALID_DOCUMENT / document_not_ready on the owner's own extraction_failed document", async () => {
    h = await createRouteHarness();
    const guest = guestCookie();
    const principal: Principal = { type: "guest", guestSessionId: guest.guestSessionId };
    const doc = await pendingDoc(principal, "failed.txt");
    await markDocumentExtractionFailed(h.t.db, principal, doc.id);

    const res = await getText(doc.id, guest.cookie);

    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: { code: "INVALID_DOCUMENT", message: expect.any(String), reason: "document_not_ready" } });
  });

  // markDocumentReady is the only repository write that ever sets canonical_text, and it always
  // flips processing_status to "ready" in the same statement — so this row shape never occurs
  // through the app's own write paths. It proves the route's ready check isn't redundant with the
  // null checks alone: a row that somehow has text but never transitioned still refuses.
  it("422 INVALID_DOCUMENT / document_not_ready on a still-pending row that already carries canonical_text (the ready check, not just the null checks)", async () => {
    h = await createRouteHarness();
    const guest = guestCookie();
    const principal: Principal = { type: "guest", guestSessionId: guest.guestSessionId };
    const doc = await pendingDoc(principal, "bypassed.txt");
    const text = "The tenant agrees to a standard deposit clause.";
    const textHash = createHash("sha256").update(text, "utf8").digest("hex");
    await h.t.db
      .update(schema.documents)
      .set({ canonicalText: text, canonicalTextHash: textHash, inputMode: "text" })
      .where(eq(schema.documents.id, doc.id));

    const res = await getText(doc.id, guest.cookie);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "INVALID_DOCUMENT", message: expect.any(String), reason: "document_not_ready" } });
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/"text"\s*:/);
    expect(raw).not.toMatch(/"textHash"\s*:/);
  });

  it("a native_document's transcription is returned byte-exact — never run through sanitizeModelText(), so bindSpan()'s slice check stays exact", async () => {
    h = await createRouteHarness();
    const guest = guestCookie();
    const principal: Principal = { type: "guest", guestSessionId: guest.guestSessionId };
    const doc = await pendingDoc(principal, "scanned.txt");
    const hostileText = "The tenant agrees to a ✅‮standard‬ deposit clause.";
    const canonicalTextHash = createHash("sha256").update(hostileText, "utf8").digest("hex");
    await markDocumentReady(h.t.db, principal, doc.id, {
      inputMode: "native_document",
      canonicalText: hostileText,
      canonicalTextHash,
      extractorVersion: "test",
      documentType: "leave_and_license",
      detectionConfidence: "0.50",
      jurisdiction: "IN",
    });

    const res = await getText(doc.id, guest.cookie);

    expect(res.status).toBe(200);
    const body = DocumentTextOutput.parse(await res.json());
    expect(body.inputMode).toBe("native_document");
    // Byte-exact: the badge glyph and bidi control survive untouched.
    expect(body.text).toBe(hostileText);
    expect(body.textHash).toBe(canonicalTextHash);
  });
});
