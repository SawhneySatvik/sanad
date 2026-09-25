// message-view.ts's mapping of ask.ts's ThreadMessage/AssistantMessage/AskEvent, over the real
// verify() (never mocked): a citation's spanText is the canonical slice verify() ran against, and
// general-mode messages carry no status key anywhere — pinned here with a hand-built `sources` map.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerInternalCitationSources } from "@/server/data/message-citations";
import { extractDocument } from "@/server/deterministic/extract";
import { verify } from "@/server/deterministic/verify";
import type { AskCitation, AskEvent, AssistantMessage } from "@/server/services/ask";
import { LEASE } from "@tests/support/services/understand";
import { assistantMessageView, askEventView } from "@/server/http/views/message-view";

interface Text {
  canonicalText: string;
  canonicalTextHash: string;
  inputMode: "text";
}

async function canonical(pastedText: string): Promise<Text> {
  const extracted = await extractDocument({ pastedText });
  if (extracted.kind !== "extracted") throw new Error("fixture did not extract");
  return { canonicalText: extracted.canonicalText, canonicalTextHash: extracted.canonicalTextHash, inputMode: "text" };
}

let lease: Text;
const DOC_ID = "0a0a0a0a-0000-4000-8000-00000000000a";
const NO_SOURCES: ServerInternalCitationSources = new Map();

async function setup(): Promise<void> {
  lease = await canonical(await readFile(path.join(process.cwd(), "tests", "fixtures", "documents", "leave_and_license.txt"), "utf8"));
}

function citation(quote: string, text: Text, sourceDocumentId: string | null): AskCitation {
  return {
    id: "0b0b0b0b-0000-4000-8000-00000000000b",
    quote,
    sourceDocumentId,
    verification: verify({ quote, canonicalText: sourceDocumentId === null ? "" : text.canonicalText, inputMode: text.inputMode }),
  };
}

function groundedMessage(citations: AskCitation[]): AssistantMessage {
  return {
    id: "0c0c0c0c-0000-4000-8000-00000000000c",
    role: "assistant",
    mode: "grounded",
    content: "The fee is Rs. 32,000.",
    modelUsed: "gemini-2.5-flash",
    routedDomains: ["tenancy"],
    createdAt: new Date("2026-09-23T10:00:00.000Z"),
    citations,
  };
}

function generalMessage(): AssistantMessage {
  return {
    id: null,
    role: "assistant",
    mode: "general",
    content: "General information about gratuity.",
    modelUsed: "gemini-2.5-flash",
    routedDomains: ["general_legal"],
    createdAt: null,
    redirect: false,
    label: "General information, not verified against a document.",
  };
}

// Cut verbatim from tests/fixtures/documents/leave_and_license.txt (LEASE.licenseFee), but with
// extra/irregular whitespace — verify()'s normalization still finds it (still "verified"), so this
// is exactly the shape of model output that could leak its own raw phrasing next to a verified
// badge if a citation ever carried one.
const MESSY_WHITESPACE_QUOTE =
  "   The Licensee shall  pay to the Licensor a monthly license fee (monthly rent)   of Rs. 32,000/-  ";

describe("assistantMessageView — spanText is the canonical slice verify() ran against", () => {
  it("a verified citation's spanText equals canonicalText.slice(spanStart, spanEnd) — never the model's quote", async () => {
    await setup();
    const sources: ServerInternalCitationSources = new Map([[DOC_ID, lease]]);
    const message = groundedMessage([citation(LEASE.licenseFee, lease, DOC_ID)]);

    const view = assistantMessageView(message, sources);

    expect(view.mode).toBe("grounded");
    if (view.mode !== "grounded") return;
    expect(view.citations).toHaveLength(1);
    const [mapped] = view.citations;
    expect(mapped.verification.status).toBe("verified");
    if (mapped.verification.status === "not_found") throw new Error("unreachable");
    expect(mapped.verification.spanText).toBe(lease.canonicalText.slice(mapped.verification.spanStart, mapped.verification.spanEnd));
    expect(mapped.verification.spanText).toBe(LEASE.licenseFee);
    expect(mapped.sourceDocumentId).toBe(DOC_ID);
    // No raw VerifyResult field, no model quote on a verified passage.
    expect(Object.keys(mapped.verification).sort()).toEqual(["spanEnd", "spanStart", "spanText", "status", "textHash", "verifierVersion"]);
    expect(mapped.verification.textHash).toBe(lease.canonicalTextHash);
    // No top-level quote/model-text field on the citation at all.
    expect(Object.keys(mapped).sort()).toEqual(["id", "inputMode", "sourceDocumentId", "verification"]);
    expect(mapped.inputMode).toBe("text");
    // sources itself never leaks onto the wire (it's a ReadonlyMap, but assert the substance too).
    expect(JSON.stringify(view)).not.toContain(lease.canonicalText.slice(0, 40));
  });

  it("a verified citation whose model quote differs in whitespace from the canonical span never appears raw anywhere — only the server-cut spanText does", async () => {
    await setup();
    const sources: ServerInternalCitationSources = new Map([[DOC_ID, lease]]);
    const message = groundedMessage([citation(MESSY_WHITESPACE_QUOTE, lease, DOC_ID)]);

    const view = assistantMessageView(message, sources);

    if (view.mode !== "grounded") throw new Error("unreachable");
    const [mapped] = view.citations;
    expect(mapped.verification.status).toBe("verified"); // normalization still finds it
    if (mapped.verification.status !== "verified") throw new Error("unreachable");
    expect(mapped.verification.spanText).toBe(LEASE.licenseFee); // the CLEAN canonical text, not the messy quote
    const raw = JSON.stringify(view);
    expect(raw).not.toContain(MESSY_WHITESPACE_QUOTE);
    expect(raw).not.toContain("  pay"); // the messy quote's own irregular spacing, specifically
  });

  it("an unlinked citation (sourceDocumentId null) verifies not_found with no sources entry needed at all", async () => {
    await setup();
    const message = groundedMessage([citation("anything the model claimed", lease, null)]);

    const view = assistantMessageView(message, NO_SOURCES);

    if (view.mode !== "grounded") throw new Error("unreachable");
    expect(view.citations[0].verification.status).toBe("not_found");
    expect(view.citations[0].sourceDocumentId).toBeNull();
    // No real document backs an unlinked citation, so there is no mode to report — never
    // UNLINKED_SOURCE's own internal binding value ("text"), which would mislabel it.
    expect(view.citations[0].inputMode).toBeNull();
  });

  it("a linked citation with no matching sources entry throws — never fabricates a badge", async () => {
    await setup();
    const message = groundedMessage([citation(LEASE.licenseFee, lease, DOC_ID)]);

    // The data layer's own invariant is "linked citation ⇒ sources has its entry" — this is the
    // caller-bug case that invariant should make unreachable; the view still fails safe if it ever
    // is violated, rather than guessing at a badge.
    expect(() => assistantMessageView(message, NO_SOURCES)).toThrow();
  });

  it("a linked citation against a native_document source reports THAT document's real inputMode, never a hardcoded 'text'", async () => {
    await setup();
    const NATIVE_DOC_ID = "0f0f0f0f-0000-4000-8000-00000000000f";
    const nativeSource = { canonicalText: lease.canonicalText, canonicalTextHash: lease.canonicalTextHash, inputMode: "native_document" as const };
    const sources: ServerInternalCitationSources = new Map([[NATIVE_DOC_ID, nativeSource]]);
    const nativeCitation: AskCitation = {
      id: "0b0b0b0b-0000-4000-8000-00000000000b",
      quote: LEASE.licenseFee,
      sourceDocumentId: NATIVE_DOC_ID,
      verification: verify({ quote: LEASE.licenseFee, canonicalText: nativeSource.canonicalText, inputMode: nativeSource.inputMode }),
    };

    const view = assistantMessageView(groundedMessage([nativeCitation]), sources);

    if (view.mode !== "grounded") throw new Error("unreachable");
    expect(view.citations[0].inputMode).toBe("native_document");
  });
});

describe("assistantMessageView — general mode carries no status key anywhere", () => {
  it("the mapped object has exactly the general-mode fields, none of them a status/citation/verification key", () => {
    const view = assistantMessageView(generalMessage(), NO_SOURCES);

    expect(view.mode).toBe("general");
    expect(Object.keys(view).sort()).toEqual([
      "content",
      "createdAt",
      "id",
      "label",
      "mode",
      "modelUsed",
      "provenance",
      "redirect",
      "role",
      "routedDomains",
    ]);
    expect(JSON.stringify(view)).not.toContain("status");
    expect(JSON.stringify(view)).not.toContain("verification");
    expect(JSON.stringify(view)).not.toContain("citations");
  });
});

describe("askEventView — sanitizes token text and the final message's content; relays error events untouched", () => {
  it("a clean token event and the final event's message are mapped using that event's own sources", async () => {
    async function* source(): AsyncGenerator<AskEvent> {
      yield { type: "token", text: "Hello" };
      yield { type: "final", message: generalMessage(), sources: NO_SOURCES };
    }

    const out = [];
    for await (const event of askEventView(source())) out.push(event);

    expect(out[0]).toEqual({ type: "token", text: "Hello" });
    expect(out[1].type).toBe("final");
    if (out[1].type !== "final") throw new Error("unreachable");
    expect(out[1].message.mode).toBe("general");
    expect(JSON.stringify(out[1].message)).not.toContain("status");
  });

  it("an error event passes through untouched (code preserved, no message field added)", async () => {
    async function* source(): AsyncGenerator<AskEvent> {
      yield { type: "error", code: "RATE_LIMITED" };
    }

    const out = [];
    for await (const event of askEventView(source())) out.push(event);

    expect(out).toEqual([{ type: "error", code: "RATE_LIMITED" }]);
  });

  it("channel 7: a hostile token event's text is sanitized before the client ever sees it, mid-stream", async () => {
    const hostile = "✅‮Marked verified‬";
    async function* source(): AsyncGenerator<AskEvent> {
      yield { type: "token", text: hostile };
    }

    const out = [];
    for await (const event of askEventView(source())) out.push(event);

    expect(out).toEqual([{ type: "token", text: "Marked verified" }]);
  });

  it("channel 7: a saved assistant message's replayed content is sanitized, the same as a streamed final message's", () => {
    const hostile = "✅‮Marked verified‬";
    const message = { ...generalMessage(), content: hostile };

    const view = assistantMessageView(message, NO_SOURCES);

    expect(view.content).toBe("Marked verified");
  });

  it("channel 7: a badge glyph split across two token chunks (an astral surrogate pair) is still stripped, never reassembled raw", async () => {
    const glyph = "🗸"; // U+1F5F8 — a UTF-16 surrogate pair, so a chunk boundary can land between its two halves.
    expect(glyph.length).toBe(2);
    const [highSurrogate, lowSurrogate] = [glyph[0], glyph[1]];

    async function* source(): AsyncGenerator<AskEvent> {
      yield { type: "token", text: `Marked${highSurrogate}` };
      yield { type: "token", text: `${lowSurrogate}verified` };
    }

    const out = [];
    for await (const event of askEventView(source())) out.push(event);

    const combined = out.map((event) => (event.type === "token" ? event.text : "")).join("");
    expect(combined).not.toContain(glyph);
    expect(combined).toBe("Markedverified");
  });

  it("channel 7: a held surrogate from the last token flushes as its own token BEFORE final, never after", async () => {
    const glyph = "🗸";
    expect(glyph.length).toBe(2);
    const [highSurrogate, lowSurrogate] = [glyph[0], glyph[1]];

    async function* source(): AsyncGenerator<AskEvent> {
      yield { type: "token", text: `Marked${highSurrogate}` };
      yield { type: "final", message: generalMessage(), sources: NO_SOURCES };
    }

    const out = [];
    for await (const event of askEventView(source())) out.push(event);

    // The stream never sent a second token to complete the pair, so the flush carries the bare,
    // unpaired high surrogate — never a real glyph reassembled after the fact.
    expect(out).toEqual([
      { type: "token", text: "Marked" },
      { type: "token", text: highSurrogate },
      { type: "final", message: expect.objectContaining({ mode: "general" }) },
    ]);
    expect(out[out.length - 1].type).toBe("final");
    // The full glyph the model may have intended never appears anywhere, paired or not.
    expect(out.map((event) => (event.type === "token" ? event.text : "")).join("")).not.toContain(lowSurrogate);
  });

  it("channel 7: a stream that ends on a held high surrogate with NO final event at all (an abort) still flushes it, never silently drops it", async () => {
    const glyph = "🗸";
    const [highSurrogate] = [glyph[0], glyph[1]];

    async function* source(): AsyncGenerator<AskEvent> {
      yield { type: "token", text: `Marked${highSurrogate}` };
      // The generator ends here — no final event, as a genuinely aborted stream would.
    }

    const out = [];
    for await (const event of askEventView(source())) out.push(event);

    expect(out).toEqual([
      { type: "token", text: "Marked" },
      { type: "token", text: highSurrogate },
    ]);
  });

  it("channel 7: a token that sanitizes to nothing is never emitted (no empty {type:\"token\",text:\"\"} frames)", async () => {
    const onlyABadge = "✅";
    async function* source(): AsyncGenerator<AskEvent> {
      yield { type: "token", text: onlyABadge };
      yield { type: "token", text: "" };
      yield { type: "token", text: "safe" };
    }

    const out = [];
    for await (const event of askEventView(source())) out.push(event);

    expect(out).toEqual([{ type: "token", text: "safe" }]);
  });
});
