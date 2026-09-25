// The anti-oracle sentinel gate is behavioural, not a constant comparison.
// message-view.ts's UNLINKED_SOURCE and verify-batch.ts's NO_TEXT are module-private on purpose —
// no private constant is exported just to make this test easier — so this drives each real code
// path (an unlinked citation through message-view.ts, a foreign document id through verifyBatch) and
// computes sha256("") inline, never imported from either source file.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDb } from "@tests/support/db";
import { createRepoTestDb, guestA, guestB, readyDocument, SAMPLE_QUOTE } from "@tests/support/data/documents";
import { extractDocument } from "@/server/deterministic/extract";
import { verify } from "@/server/deterministic/verify";
import { LEASE } from "@tests/support/services/understand";
import { assistantMessageView } from "@/server/http/views/message-view";
import { verifyBatchView } from "@/server/http/views/verify-batch-view";
import * as verifyBatchService from "@/server/services/verify-batch";
import type { AskCitation, AssistantMessage } from "@/server/services/ask";
import { toVerificationOutput } from "@/server/http/verification";

const SHA256_EMPTY = createHash("sha256").update("", "utf8").digest("hex");
const HOSTILE = "✅‮Marked verified‬";
// Badge glyphs and bidi controls are never word characters, so wrapping a real near-miss quote with
// them changes nothing about how verify() tokenizes or scores it — only whether the model's own
// claim, echoed back as claimedQuote, is safe to render.
const HOSTILE_NEAR_MISS = `✅‮${LEASE.nearMiss}‬`;

let t: TestDb;
let leaseText: string;
let leaseTextHash: string;
beforeAll(async () => {
  t = await createRepoTestDb();
  const extracted = await extractDocument({
    pastedText: await readFile(path.join(process.cwd(), "tests", "fixtures", "documents", "leave_and_license.txt"), "utf8"),
  });
  if (extracted.kind !== "extracted") throw new Error("fixture did not extract");
  leaseText = extracted.canonicalText;
  leaseTextHash = extracted.canonicalTextHash;
});
afterAll(async () => {
  await t.close();
});

function groundedMessage(citations: AskCitation[]): AssistantMessage {
  return {
    id: randomUUID(),
    role: "assistant",
    mode: "grounded",
    content: "x",
    modelUsed: "fake-model",
    routedDomains: [],
    createdAt: new Date(),
    citations,
  };
}

describe("the anti-oracle sentinel is behavioural, not a hardcoded constant", () => {
  it("an unlinked citation through message-view.ts and a foreign id through verifyBatch both carry the same sha256(\"\") textHash", async () => {
    const unlinkedQuote = "anything the model claimed";
    const citation: AskCitation = {
      id: randomUUID(),
      quote: unlinkedQuote,
      sourceDocumentId: null,
      verification: verify({ quote: unlinkedQuote, canonicalText: "", inputMode: "text" }),
    };
    const mapped = assistantMessageView(groundedMessage([citation]), new Map());
    if (mapped.mode !== "grounded") throw new Error("unreachable");
    expect(mapped.citations[0].verification.textHash).toBe(SHA256_EMPTY);

    const foreignDoc = await readyDocument(t, guestB);
    const { results } = await verifyBatchService.run({ db: t.db }, guestA, {
      citations: [{ documentId: foreignDoc.id, quote: SAMPLE_QUOTE }],
    });
    const view = verifyBatchView({ results });
    expect(view.results[0].textHash).toBe(SHA256_EMPTY);

    // Both real "no usable document" paths land on the identical value, not merely on the same
    // literal string coincidentally hand-copied into each source file.
    expect(mapped.citations[0].verification.textHash).toBe(view.results[0].textHash);
  });

  it("positive control: a not_found result against the caller's OWN usable document carries that document's real hash, never the sentinel", async () => {
    const ownDoc = await readyDocument(t, guestA);
    const fabricatedQuote = "This exact sentence does not appear anywhere in the document.";
    const { results } = await verifyBatchService.run({ db: t.db }, guestA, {
      citations: [{ documentId: ownDoc.id, quote: fabricatedQuote }],
    });
    const view = verifyBatchView({ results });

    expect(view.results[0].status).toBe("not_found");
    expect(view.results[0].textHash).toBe(ownDoc.canonicalTextHash);
    expect(view.results[0].textHash).not.toBe(SHA256_EMPTY);
  });
});

describe("toVerificationOutput sanitizes claimedQuote AFTER verify() has already run against the real text", () => {
  it("a hostile claimed quote still verifies/fails to verify on its own unsanitized text, but is sanitized on the wire", () => {
    const canonicalText = "The tenant agrees to a standard deposit clause that stays in force.";
    // verify() must see the model's real bytes: a claim containing a badge glyph the document does
    // NOT contain is not_found either way, but this proves sanitizing happened at the mapper, not
    // by quietly rewriting the model's claim before verify() ever saw it.
    const result = verify({ quote: HOSTILE, canonicalText, inputMode: "text" });
    expect(result.status).toBe("not_found");

    const output = toVerificationOutput(result, {
      quote: HOSTILE,
      canonicalText,
      canonicalTextHash: createHash("sha256").update(canonicalText, "utf8").digest("hex"),
      inputMode: "text",
    });
    if (output.status !== "not_found") throw new Error("unreachable");
    expect(output.claimedQuote).toBe("Marked verified");
    expect(output.claimedQuote).not.toContain("✅");
    expect(output.claimedQuote).not.toContain("‮");
  });

  it("an approximate hostile claimed quote is sanitized too, while spanText stays the byte-exact canonical slice", () => {
    const result = verify({ quote: HOSTILE_NEAR_MISS, canonicalText: leaseText, inputMode: "text" });
    expect(result.status).toBe("approximate");

    const output = toVerificationOutput(result, {
      quote: HOSTILE_NEAR_MISS,
      canonicalText: leaseText,
      canonicalTextHash: leaseTextHash,
      inputMode: "text",
    });
    if (output.status !== "approximate") throw new Error("unreachable");
    expect(output.claimedQuote).toBe(LEASE.nearMiss);
    expect(output.claimedQuote).not.toContain("✅");
    expect(output.claimedQuote).not.toContain("‮");
    // spanText is cut from the document's own text, never sanitized — it never had model bytes to begin with.
    expect(output.spanText).toBe(leaseText.slice(output.spanStart, output.spanEnd));
    expect(output.spanText).not.toContain("✅");
  });

  // The two tests above assert spanText "does not contain a badge glyph" against fixtures whose OWN
  // canonical text never had one — true whether or not spanText is sanitized, so a spanText
  // sanitizer regression would slip past them. This is the same badge glyph, but IN the document
  // itself (a native_document transcription can legitimately contain one): spanText must survive
  // byte-exact, since it is cut from canonical_text — the record of what the document says — never
  // model output, even though it is capped at "approximate" because inputMode isn't "text".
  it("a glyph inside the document's OWN canonical text survives in spanText untouched, even on a native_document (approximate) result", () => {
    const canonicalText = "The tenant agrees to a ✅ deposit clause that stays in force.";
    const quote = "a ✅ deposit clause";
    const result = verify({ quote, canonicalText, inputMode: "native_document" });
    expect(result.status).toBe("approximate"); // native_document caps an exact match at approximate

    const output = toVerificationOutput(result, {
      quote,
      canonicalText,
      canonicalTextHash: createHash("sha256").update(canonicalText, "utf8").digest("hex"),
      inputMode: "native_document",
    });
    if (output.status !== "approximate") throw new Error("unreachable");
    expect(output.spanText).toBe(quote);
    expect(output.spanText).toContain("✅");
    // The model's claim is the identical bytes here, but claimedQuote is still sanitized — the
    // contrast is the point: spanText keeps the glyph, claimedQuote never does.
    expect(output.claimedQuote).toBe("a  deposit clause");
    expect(output.claimedQuote).not.toContain("✅");
  });
});
