import { describe, expect, it } from "vitest";
import { DRAFTABLE_DOCUMENT_TYPE_IDS } from "@/server/deterministic/draft-templates";
import { MAX_INSTRUCTIONS_CHARS } from "@/server/prompts/draft/prompt";
import { CreateDraftInput, DraftOutput, DraftSectionOutput, DraftWithSectionsOutput, ReviseDraftInput } from "@/shared/contracts/drafts";

const section = { key: "parties_and_purpose", heading: "Parties and Purpose", provenance: "ai_generated", content: "Acme and Bob." };

const draft = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  title: "NDA draft",
  documentType: "nda",
  mode: "from_scratch",
  groundingDocumentId: null,
  revisionNumber: 1,
  parentDraftId: null,
  createdAt: "2026-09-23T10:00:00.000Z",
  expiresAt: null,
  modelUsed: "gemini-2.5-flash",
  jurisdiction: "IN",
  groundingDocumentAvailable: null,
  promptVersion: "draft-v1",
  content: "## Parties and Purpose\n\nAcme and Bob.",
  sections: [section],
};

describe("CreateDraftInput / ReviseDraftInput are strict — a client never supplies provenance or a status", () => {
  const input = { mode: "from_scratch", documentType: "nda", userInstructions: "Draft an NDA between Acme and Bob.", jurisdiction: "IN" };

  it("accepts the fields it names, groundingDocumentId omitted for from_scratch", () => {
    expect(CreateDraftInput.parse(input)).toEqual(input);
  });

  it("accepts a document_grounded request with a groundingDocumentId", () => {
    const grounded = { ...input, mode: "document_grounded", groundingDocumentId: "0b0b0b0b-0000-4000-8000-00000000000b" };
    expect(CreateDraftInput.safeParse(grounded).success).toBe(true);
  });

  it.each(["provenance", "status", "verified", "content", "modelUsed"])("rejects a `%s` key", (key) => {
    expect(CreateDraftInput.safeParse({ ...input, [key]: "x" }).success).toBe(false);
  });

  it("rejects an unrecognized documentType and an unrecognized mode", () => {
    expect(CreateDraftInput.safeParse({ ...input, documentType: "power_of_attorney" }).success).toBe(false);
    expect(CreateDraftInput.safeParse({ ...input, mode: "assisted" }).success).toBe(false);
  });

  it("rejects a lower-case or 3-letter jurisdiction", () => {
    expect(CreateDraftInput.safeParse({ ...input, jurisdiction: "in" }).success).toBe(false);
    expect(CreateDraftInput.safeParse({ ...input, jurisdiction: "USA" }).success).toBe(false);
  });

  it("ReviseDraftInput accepts only userInstructions, strict", () => {
    expect(ReviseDraftInput.parse({ userInstructions: "Make the term 2 years." })).toEqual({ userInstructions: "Make the term 2 years." });
    expect(ReviseDraftInput.safeParse({ userInstructions: "x", mode: "from_scratch" }).success).toBe(false);
  });

  // The contract's cap must match the service's real cap exactly, not drift.
  it("userInstructions' max length matches prompts/draft/prompt.ts's MAX_INSTRUCTIONS_CHARS exactly", () => {
    expect(MAX_INSTRUCTIONS_CHARS).toBe(4000);
    const atLimit = "x".repeat(MAX_INSTRUCTIONS_CHARS);
    const overLimit = "x".repeat(MAX_INSTRUCTIONS_CHARS + 1);
    expect(CreateDraftInput.safeParse({ ...input, userInstructions: atLimit }).success).toBe(true);
    expect(CreateDraftInput.safeParse({ ...input, userInstructions: overLimit }).success).toBe(false);
    expect(ReviseDraftInput.safeParse({ userInstructions: atLimit }).success).toBe(true);
    expect(ReviseDraftInput.safeParse({ userInstructions: overLimit }).success).toBe(false);
  });
});

describe("CreateDraftInput's documentType enum matches the draft-templates registry exactly", () => {
  it("has exactly the registry's draftable ids, no more, no fewer", () => {
    const contractIds = CreateDraftInput.shape.documentType.options as readonly string[];
    expect([...contractIds].sort()).toEqual([...DRAFTABLE_DOCUMENT_TYPE_IDS].sort());
  });
});

describe("a draft's wire shape carries no status/verified key anywhere", () => {
  it("accepts a real draft and round-trips it", () => {
    expect(DraftWithSectionsOutput.safeParse(draft).success).toBe(true);
    expect(DraftOutput.safeParse(draft).success).toBe(true);
  });

  // The zod shape itself is the thing this asserts: temporarily adding `status: z.string()` to
  // DraftWithSectionsOutput (or to its section schema) in drafts.ts makes this fail, so it is not a
  // vacuous assertion.
  it("neither the draft object nor any section names a status/verified/quote_span key", () => {
    const forbidden = ["status", "verified", "verification", "quoteSpanStart", "quoteSpanEnd"];
    const topLevelKeys = Object.keys(DraftWithSectionsOutput.shape);
    for (const key of forbidden) expect(topLevelKeys).not.toContain(key);

    const sectionKeys = Object.keys(DraftSectionOutput.shape);
    for (const key of forbidden) expect(sectionKeys).not.toContain(key);
    expect(sectionKeys.sort()).toEqual(["content", "heading", "key", "provenance"]);
  });

  it("a status value a client sends is not even accepted as provenance — provenance is a closed two-value enum", () => {
    expect(
      DraftWithSectionsOutput.safeParse({ ...draft, sections: [{ ...section, provenance: "verified" }] }).success,
    ).toBe(false);
  });

  it("strips a server-internal field a service result might carry alongside a section (e.g. an id column)", () => {
    const parsed = DraftWithSectionsOutput.parse({ ...draft, sections: [{ ...section, id: "0e0e0e0e-0000-4000-8000-00000000000e", draftId: draft.id }] });
    expect(parsed.sections[0]).toEqual(section);
  });

  // `content` (the flattened full text) and `sections` (each with its own provenance) are BOTH
  // required together — a caller that wants to know which parts are templated vs. model-authored
  // reads `sections`, never has to infer it from `content` alone.
  it("both content (flattened) AND sections (with per-section provenance) are present together, never one without the other", () => {
    const parsed = DraftWithSectionsOutput.parse(draft);
    expect(typeof parsed.content).toBe("string");
    expect(parsed.content.length).toBeGreaterThan(0);
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(parsed.sections[0].provenance).toBe("ai_generated");
    expect(Object.keys(DraftWithSectionsOutput.shape)).toEqual(expect.arrayContaining(["content", "sections"]));
  });
});
