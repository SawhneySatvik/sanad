// This screen's own done-when gates. There is no dedicated "/upload" route — every one of these
// gates exercises the upload mechanism through the /chat composer
// (src/components/upload/index.ts's named exports are what it mounts). Every UI-driven gate below
// is marked test.fixme with a one-line reason until the composer-specific selectors land; whoever
// wires the composer's real mount removes the fixme and fills them in.
//
// The one exception is `upload.empty-relay-rejects-zero-bytes`: it needs no page mount at all — it
// drives POST /api/uploads -> PUT the relay directly through page.request (the per-test IP the
// context/page fixtures already carry), a synthetic zero-byte upload with no bundled fixture. Run
// for real, not fixme'd.

import { test, expect } from "../support/fixtures";

const CHAT_MOUNT_REASON = "needs the /chat composer, which mounts UploadDropzone/UploadProgress/UploadErrorCard";

test.describe("Upload — real, no-mount-needed", () => {
  test("upload.empty-relay-rejects-zero-bytes: a real zero-byte PUT is rejected with reason 'empty'", async ({ page }) => {
    const targetResponse = await page.request.post("/api/uploads", {
      data: { filename: "empty.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    });
    expect(targetResponse.ok()).toBe(true);
    const target = (await targetResponse.json()) as { method: string; uploadUrl: string; ref: string };
    expect(target.method).toBe("server-relay");

    // Zero real bytes regardless of the sizeBytes declared above — assertWrittenSizeAllowed's own
    // <= 0 branch, the actual-bytes half of F6.1's "empty (zero-byte)" row.
    const relayResponse = await page.request.put(target.uploadUrl, { data: Buffer.alloc(0) });

    expect(relayResponse.status()).toBe(422);
    const body = (await relayResponse.json()) as { error: { code: string; reason?: string; message: string } };
    expect(body.error.code).toBe("INVALID_DOCUMENT");
    expect(body.error.reason).toBe("empty");
    expect(body.error.message).toBe("The uploaded document could not be processed.");
  });

  test("upload.empty-relay-rejects-zero-bytes: no document row survives the rejection", async ({ page }) => {
    const targetResponse = await page.request.post("/api/uploads", {
      data: { filename: "empty2.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    });
    const target = (await targetResponse.json()) as { uploadUrl: string };
    await page.request.put(target.uploadUrl, { data: Buffer.alloc(0) });

    const listResponse = await page.request.get("/api/documents");
    expect(listResponse.ok()).toBe(true);
    const list = (await listResponse.json()) as { items: { filename: string }[] };
    expect(list.items.some((item) => item.filename === "empty2.pdf")).toBe(false);
  });
});

// test.fixme(title, body) needs a real body function, but there are no composer-specific selectors
// written against it yet — the sanctioned in-body form, test.fixme(condition, description), is what
// each placeholder below uses: the test is registered under its final gate name (so `--grep`
// already finds it once those selectors land), reported as "fixme" rather than silently absent from
// the run, and carries its one-line reason as the description Playwright prints for a fixme'd test.

test.describe("Upload — the full reason matrix (needs the mounted composer)", () => {
  const REASONS = ["unsupported_type", "too_large", "empty", "type_mismatch"] as const;

  for (const reason of REASONS) {
    test(`upload.rejected-${reason}: page.route injects the server's reason regardless of the chosen file's own properties`, async () => {
      test.fixme(true, CHAT_MOUNT_REASON);
    });
  }

  test("upload.rejected-unreadable: the real picker with tests/fixtures/documents/corrupt.pdf reaches the server's own EXTRACTION_FAILED copy", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });

  test("upload.rejected-unmapped-fallback: an unrecognised reason value falls back to the fixed per-code message, never invents copy", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });

  test("asserts distinct copy per reason (fails if two reasons render identical text), and that empty is the one reason allowed to repeat across its two stages (F6.1)", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });
});

test.describe("Upload — progress and method (needs the mounted composer)", () => {
  test("upload.progress-is-real: throttled network, leave_and_license.pdf; the bar's value strictly increases with bytes sent, and no numeric percentage renders during the POST /api/documents phase", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });

  test("upload.follows-returned-method: intercepts POST /api/uploads to return a direct-put method/uploadUrl; asserts the client PUTs that exact URL, never a hard-coded /api/uploads/relay", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });

  test("upload.client-pre-checks-need-no-request: a 0-byte file, an oversized one and a disallowed type each render UploadErrorCard with zero POST /api/uploads calls", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });
});

test.describe("Upload — retry, offline, and the guest TTL notice (needs the mounted composer)", () => {
  test("upload.retry-after-row-exists: the fake provider fails once then succeeds; Retry analysis calls POST /api/documents/:id/analyze with the exact documentId, and success replaces the error card with the same document chip a direct success produces", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });

  test("upload.offline-blocks-attach: context.setOffline(true) before choosing a file; the attach control is disabled, OfflineBanner's exact string renders, and zero POST /api/uploads calls fire", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });

  test("upload.ttl-notice-reads-session-not-hardcoded: GET /api/session -> guestTtlHours: 7 renders '7' in the notice, never a hard-coded '2-4'; kind: 'user' renders no notice; a delayed session response renders no notice/placeholder until it resolves", async () => {
    test.fixme(true, CHAT_MOUNT_REASON);
  });
});

test.describe("Upload — accessibility (needs the mounted composer)", () => {
  const AXE_STATES = [
    "idle composer",
    "mid-drag (desktop)",
    "determinate progress",
    "indeterminate progress",
    "every UploadErrorCard variant",
  ] as const;

  for (const state of AXE_STATES) {
    test(`axe: ${state} — zero serious/critical`, async () => {
      test.fixme(true, CHAT_MOUNT_REASON);
    });
  }
});
