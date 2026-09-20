// A "removed"/"added" candidate whose only side's text is, once whitespace is normalised, still
// present verbatim on the other side: most often one file format split a paragraph into several
// clauses (each wrapped line its own clause) where the other format kept it as one. compare()
// drops these before persisting; a genuine removal or addition is never touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { compare, get } from "@/server/services/compare";
import { type CompareHarness, createCompareHarness, explainAll, guestA } from "@tests/support/services/compare";

let h: CompareHarness;
beforeEach(async () => {
  h = await createCompareHarness();
});
afterEach(async () => {
  await h.close();
});

// A spy that captures every console.warn call as parsed JSON, restored after the test.
function spyOnWarn() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return {
    events: () => warn.mock.calls.map((args) => args.map(String).join(" ")),
    restore: () => warn.mockRestore(),
  };
}

describe("compare() drops a change whose only side's text is still present on the other side", () => {
  // Mirrors the reported bug: document A extracted from DOCX, each wrapped line of the letterhead
  // its own paragraph/clause; document B extracted as plain text, the same lines kept as one
  // paragraph. The company name and the city/PIN line are still there in B, merged into one clause —
  // only the address line was genuinely deleted.
  const A = `Offer Letter

ABC Innovations Pvt Ltd

Level 2, Cyber Towers, Hitech City

Hyderabad 500081

[Address withheld]

Dear Ananya Sharma,

We are pleased to offer you employment as a Software Engineer at ABC Innovations Pvt Ltd, reporting to the Hyderabad office, with a monthly salary of Rs. 80,000.

Please sign below to accept this offer.`;

  const B = `Offer Letter

ABC Innovations Pvt Ltd
Level 2, Cyber Towers, Hitech City
Hyderabad 500081

Dear Ananya Sharma,

We are pleased to offer you employment as a Software Engineer at ABC Innovations Pvt Ltd, reporting to the Hyderabad office, with a monthly salary of Rs. 90,000.

Please sign below to accept this offer.`;

  it("drops the false removals, keeps the genuine one, and get() shows the same changes back", async () => {
    const spy = spyOnWarn();
    try {
      const llm = new FakeLlmClient({ defaultResponse: explainAll() });
      const a = await h.document(guestA, A);
      const b = await h.document(guestA, B);

      const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

      // findCandidateChanges itself reports 5 candidates (2 false removals, 2 changed, 1 genuine
      // removal); only 3 are persisted.
      expect(result.changes.map((c) => c.changeType)).toEqual(["changed", "removed", "changed"]);
      expect(await h.counts()).toEqual({ comparisons: 1, changes: 3 });

      const removed = result.changes.find((c) => c.changeType === "removed")!;
      expect(removed.quoteA).toBe("[Address withheld]");
      expect(removed.verificationA!.status).toBe("verified");

      // Neither dropped company-header nor city/PIN text is ever stored or shown as its own change.
      expect(result.changes.some((c) => c.quoteA === "ABC Innovations Pvt Ltd")).toBe(false);
      expect(result.changes.some((c) => c.quoteA === "Hyderabad 500081")).toBe(false);

      const events = spy.events();
      const dropped = events.filter((line) => line.includes("compare_changes_dropped")).map((line) => JSON.parse(line));
      expect(dropped).toEqual([{ event: "compare_changes_dropped", surface: "compare", removedPresent: 2, addedPresent: 0 }]);
      expect(events.join("\n")).not.toMatch(/ABC Innovations|Hyderabad 500081/);

      // The re-read path never re-adds a dropped change, and it re-derives the same clause binding
      // for what was kept: no quote or verification is lost on reload.
      const reread = await get(h.deps(new FakeLlmClient()), guestA, result.comparison.id);
      expect(reread.changes).toEqual(result.changes);
      for (const change of reread.changes) {
        if (change.changeType !== "removed" || change.quoteA !== null) {
          expect(change.verificationA).not.toBeNull();
        }
      }
    } finally {
      spy.restore();
    }
  });
});

describe("compare() drops an added change whose only side's text is still present in document A", () => {
  // The same fixture with the roles reversed: document A is the plain-text (consolidated) version
  // and document B is the DOCX-like (wrapped-line) version, so the header/city/PIN lines look
  // "added" instead of "removed" — and the address line is a genuine addition.
  const A = `Offer Letter

XYZ Traders Pvt Ltd
Tower B, Business Park
Chennai 600001

Dear Rohan Verma,

We are pleased to offer you employment as a Sales Executive at XYZ Traders Pvt Ltd, reporting to the Chennai office, with a monthly salary of Rs. 40,000.

Please sign below to accept this offer.`;

  const B = `Offer Letter

XYZ Traders Pvt Ltd

Tower B, Business Park

Chennai 600001

[Address withheld]

Dear Rohan Verma,

We are pleased to offer you employment as a Sales Executive at XYZ Traders Pvt Ltd, reporting to the Chennai office, with a monthly salary of Rs. 45,000.

Please sign below to accept this offer.`;

  it("drops the false additions, keeps the genuine one, and get() shows the same changes back", async () => {
    const spy = spyOnWarn();
    try {
      const llm = new FakeLlmClient({ defaultResponse: explainAll() });
      const a = await h.document(guestA, A);
      const b = await h.document(guestA, B);

      const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

      expect(result.changes.map((c) => c.changeType)).toEqual(["added", "changed"]);
      const added = result.changes.find((c) => c.changeType === "added")!;
      expect(added.quoteB).toBe("[Address withheld]");
      expect(added.verificationB!.status).toBe("verified");

      const events = spy.events();
      const dropped = events.filter((line) => line.includes("compare_changes_dropped")).map((line) => JSON.parse(line));
      expect(dropped).toEqual([{ event: "compare_changes_dropped", surface: "compare", removedPresent: 1, addedPresent: 3 }]);

      const reread = await get(h.deps(new FakeLlmClient()), guestA, result.comparison.id);
      expect(reread.changes).toEqual(result.changes);
      expect(reread.changes.find((c) => c.changeType === "added")!.quoteB).toBe("[Address withheld]");
    } finally {
      spy.restore();
    }
  });
});

describe("very short text is never dropped, even when it is genuinely present on the other side", () => {
  const A = `1. Gamma clause about parking spaces allocated to the tenant of the unit for the full duration of this agreement without exception.

2. OK

3. Omega clause about termination notice periods for both parties under this agreement in full.`;

  const B = `1. Gamma clause about parking spaces allocated to the tenant of the unit for the full duration of this agreement without exception, noting OK as an internal reference code for filing purposes only going forward.

3. Omega clause about termination notice periods for both parties under this agreement in full.`;

  it('keeps a "removed" change whose text is under 12 non-space characters', async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll({ c2: { quoteA: "OK" } }) });
    const a = await h.document(guestA, A);
    const b = await h.document(guestA, B);

    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

    expect(result.changes.map((c) => c.changeType)).toEqual(["changed", "removed"]);
    const removed = result.changes.find((c) => c.changeType === "removed")!;
    expect(removed.quoteA).toBe("OK");
    expect(removed.verificationA!.status).toBe("verified");
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 2 });

    const reread = await get(h.deps(new FakeLlmClient()), guestA, result.comparison.id);
    expect(reread.changes).toEqual(result.changes);
  });
});

describe("whitespace-only differences still count as present on the other side", () => {
  // Document A keeps the three address lines as one clause, joined by single newlines (as a plain
  // text export would); document B has the very same three lines, unedited, but each its own
  // paragraph (blank-line separated, as a wrapped-line DOCX export would). The words are identical;
  // only the amount of whitespace between them differs, so a raw substring check would miss it.
  const A = `Offer Letter

DEF Consulting LLP
Sector 5, Tech Park
Pune 411001

Dear Priya Nair,

We are pleased to offer you employment as an Analyst at DEF Consulting LLP, with a monthly salary of Rs. 60,000.

Please sign below to accept this offer.`;

  const B = `Offer Letter

DEF Consulting LLP

Sector 5, Tech Park

Pune 411001

Dear Priya Nair,

We are pleased to offer you employment as an Analyst at DEF Consulting LLP, with a monthly salary of Rs. 65,000.

Please sign below to accept this offer.`;

  it("drops a removed change whose raw text differs only in whitespace from what is in B", async () => {
    const llm = new FakeLlmClient({ defaultResponse: explainAll() });
    const a = await h.document(guestA, A);
    const b = await h.document(guestA, B);

    const removedText = "DEF Consulting LLP\nSector 5, Tech Park\nPune 411001";
    // The raw text (single newlines) is not a substring of B (blank lines between the same three
    // lines); only the whitespace-collapsed comparison makes it present.
    expect(b.canonicalText).not.toContain(removedText);
    expect(b.canonicalText!.replace(/\s+/g, " ")).toContain(removedText.replace(/\s+/g, " "));

    const result = await compare(h.deps(llm), guestA, { documentAId: a.id, documentBId: b.id });

    // The merged address block ("removed") and two of its three split-out lines ("added") are all
    // dropped as the same words, differently laid out; "Pune 411001" survives the drop check (under
    // 12 non-space characters), and the amount change is untouched either way.
    expect(result.changes.map((c) => c.changeType)).toEqual(["added", "changed"]);
    expect(result.changes.find((c) => c.changeType === "added")!.quoteB).toBe("Pune 411001");
    expect(await h.counts()).toEqual({ comparisons: 1, changes: 2 });

    const reread = await get(h.deps(new FakeLlmClient()), guestA, result.comparison.id);
    expect(reread.changes).toEqual(result.changes);
  });
});
