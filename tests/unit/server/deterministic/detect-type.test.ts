import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectDocumentType, includesWholeWordPhrase } from "@/server/deterministic/detect-type";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "documents");

function loadFixtureText(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("detectDocumentType — one fixture per tuned type, each detected correctly", () => {
  const cases: [string, string][] = [
    ["leave_and_license.txt", "leave_and_license"],
    ["job_offer_letter.txt", "job_offer_letter"],
    ["nda.txt", "nda"],
    ["privacy_policy.txt", "privacy_policy"],
    ["freelance_service_agreement.txt", "freelance_service_agreement"],
  ];

  for (const [fixture, expectedType] of cases) {
    it(`detects ${fixture} as ${expectedType} with high confidence`, () => {
      const text = loadFixtureText(fixture);
      const result = detectDocumentType(text);
      expect(result.documentType).toBe(expectedType);
      // A textbook, correctly-worded document should score high even though it only ever uses
      // one phrasing per concept — confidence is measured against concepts matched, not every
      // synonym in the signature.
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });
  }
});

describe("detectDocumentType — fallback behavior", () => {
  it("falls back to generic for text with no matching signature", () => {
    const result = detectDocumentType("The quick brown fox jumps over the lazy dog repeatedly.");
    expect(result.documentType).toBe("generic");
    expect(result.confidence).toBe(0);
  });

  it("falls back to generic for empty text", () => {
    const result = detectDocumentType("");
    expect(result.documentType).toBe("generic");
  });

  it("is case-insensitive", () => {
    const result = detectDocumentType(loadFixtureText("nda.txt").toUpperCase());
    expect(result.documentType).toBe("nda");
  });

  it("never returns 'grounded_response' (a Draft-only output category, not auto-detected)", () => {
    // Even a document that mentions the word "response" a lot should never
    // land on the Draft-only category — it has no detection signature at
    // all, by construction (document-type-registry.ts), so this is really
    // asserting the registry design, not the specific fixture text.
    const result = detectDocumentType("This is a response to a legal response about responses.");
    expect(result.documentType).not.toBe("grounded_response");
  });

  it("falls back to generic for a non-contract recipe", () => {
    const text =
      "To make a simple tomato soup, first chop two onions and one clove of garlic. Heat a " +
      "tablespoon of oil in a heavy-bottomed pan over medium heat, then add the onions and cook " +
      "until soft and translucent. Stir in the garlic and cook for another minute before adding " +
      "six ripe tomatoes, roughly chopped. Simmer for twenty minutes, then blend until smooth and " +
      "season with salt and pepper to taste.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("generic");
    expect(result.confidence).toBe(0);
  });

  it("falls back to generic for a non-contract essay", () => {
    const text =
      "The history of the printing press is often told as a story of a single inventor, but it " +
      "was really the convergence of several existing technologies: the screw press used for " +
      "wine and olives, movable metal type developed through centuries of trial, and oil-based " +
      "inks that could adhere to metal rather than wood. Gutenberg's genius lay in combining " +
      "these elements into a workable system, not in inventing any one of them from scratch.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("generic");
    expect(result.confidence).toBe(0);
  });

  it("falls back to generic for a text that mentions one concept from several unrelated types", () => {
    // Each type only clears a single, low concept (a third or less of its signature), so the
    // eventual winner's own confidence still lands under the threshold — mixing signals from
    // several types must not be enough to commit to any one of them.
    const text =
      "The parties refer to the Licensee in one clause. Elsewhere, the same document discusses " +
      "confidential information and a notice period, along with an independent contractor " +
      "arrangement, without settling on any single framework for the relationship.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("generic");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.3);
  });
});

describe("includesWholeWordPhrase — whole-word matching, not bare substring", () => {
  it("does not match 'nda' inside 'standard' or 'calendar'", () => {
    expect(includesWholeWordPhrase("this is the standard approach", "nda")).toBe(false);
    expect(includesWholeWordPhrase("a calendar-based schedule", "nda")).toBe(false);
  });

  it("matches 'nda' as a standalone word", () => {
    expect(includesWholeWordPhrase("we signed the nda yesterday", "nda")).toBe(true);
    expect(includesWholeWordPhrase("nda at the start", "nda")).toBe(true);
    expect(includesWholeWordPhrase("ends with an nda", "nda")).toBe(true);
  });

  it("matches multi-word phrases correctly, respecting boundaries on both ends", () => {
    expect(includesWholeWordPhrase("the leave and license agreement herein", "leave and license")).toBe(true);
    expect(includesWholeWordPhrase("sublease and licenser terms", "leave and license")).toBe(false);
  });
});

describe("detectDocumentType — whole-word matching, not bare substring", () => {
  it("does not false-positive on 'nda' appearing inside 'standard' or 'calendar'", () => {
    const text =
      "This document sets the standard calendar-based schedule for project milestones and deliverables review. " +
      "It contains no confidentiality, disclosure, or agreement language of any kind relevant to non-disclosure matters.";
    const result = detectDocumentType(text);
    expect(result.documentType).not.toBe("nda");
  });

  it("still detects a real, standalone 'NDA' mention as a whole word", () => {
    const text =
      "This NDA (Non-Disclosure Agreement) is entered into by the disclosing party and receiving party. " +
      "Confidential information shared under this NDA is subject to confidentiality obligations for both parties, " +
      "who agree this is a mutual non-disclosure arrangement.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("nda");
  });

  it("detects an ordinary Indian Rent Agreement using Landlord/Tenant phrasing (not leave-and-license terminology)", () => {
    const text = `
      RENT AGREEMENT

      This Rent Agreement is made between the Landlord and the Tenant for the residential premises
      described below, for a period of eleven months, renewable by mutual consent of both parties.

      The Tenant shall pay the Landlord a monthly rent as agreed, along with a security deposit
      prior to taking possession. The Landlord shall be responsible for structural repairs, and the
      Tenant shall bear routine maintenance and utility charges during the tenancy.
    `;
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("leave_and_license");
    // Reaches 16 of the type's 20 max points: every concept but lock-in and vacant possession, and
    // one point under the document-name concept's ceiling ("Rent Agreement" outweighs less than
    // "Leave and License Agreement" would) — already enough to clear the 0.8 bar.
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("produces a 0 < confidence < 0.3 result that still falls back to generic (a real, distinguishable case, not a placeholder)", () => {
    // Mentions exactly one low-weight privacy_policy signal ("cookies")
    // and nothing else from any registry entry's signature.
    const text = "Our website uses cookies to improve your browsing experience.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("generic");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.3);
  });

  it("does not mistake a Software License Agreement for a leave-and-license deed on Licensor/Licensee/license-fee terms alone", () => {
    // These three words also appear in unrelated software-licensing documents; with none of the
    // type's other concepts (document name, deposit, lock-in, term length, vacant possession)
    // present, this must stay generic rather than commit to leave_and_license.
    const text =
      "This Software License Agreement is between the Licensor and the Licensee. The Licensee shall pay an annual license fee.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("generic");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("still doesn't commit on a defined 'License Period' either — that term isn't distinctive of a property deed", () => {
    // A generic "License Period" clause reads the same in a software or IP licence, so it's not a
    // term_length member — pins that omission against reintroduction.
    const text =
      "This Software License Agreement is between the Licensor and the Licensee. The Licensee shall pay an annual license fee. The License Period is twelve months.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("generic");
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("detectDocumentType — real-world spelling and phrasing variants", () => {
  it("detects a British-spelling 'LEAVE AND LICENCE AGREEMENT' deed", () => {
    const text = `
      LEAVE AND LICENCE AGREEMENT

      This Leave and Licence Agreement is made at Mumbai between Mr. Arvind Rao, hereinafter the
      "Licensor", and Ms. Neha Kapoor, hereinafter the "Licensee".

      The Licensee shall pay the Licensor a monthly licence fee of Rs. 28,000/- along with an
      interest-free security deposit of Rs. 1,40,000/-. The Licence Period shall be eleven months
      from the date hereof. There shall be a lock-in period of three months during which neither
      party may terminate this Agreement.
    `;
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("leave_and_license");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects a 'Freelance Services Agreement' (plural) using deliverables, scope of work, and independent contractor/freelancer", () => {
    const text = `
      FREELANCE UX DESIGN SERVICES AGREEMENT

      This Freelance Services Agreement is entered into between Studio Nine LLP (the "Client") and
      Ms. Ananya Bose, an independent contractor and freelance UX designer (the "Freelancer").

      1. SCOPE OF WORK
      The Freelancer shall provide UX design services as described in the Statement of Work
      attached as Annexure A, including wireframes and prototypes for the Client's mobile
      application.

      2. DELIVERABLES
      The Freelancer shall deliver the agreed deliverables per the milestone schedule.

      3. FEES
      The Client shall pay the Freelancer a total fee of Rs. 1,80,000 in three instalments.
    `;
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("freelance_service_agreement");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("does not let a bare 'services agreement' mention tip an actual leave-and-license deed", () => {
    // The Society's own maintenance contract is incidentally named "services agreement" inside a
    // deed that is otherwise unambiguous leave-and-license terminology.
    const text = `
      LEAVE AND LICENSE AGREEMENT

      This Leave and License Agreement is between the Licensor and the Licensee. The Licensee
      shall pay the Licensor a monthly license fee of Rs. 30,000 and a security deposit of
      Rs. 1,50,000. The Society's annual services agreement for maintenance is separate from this
      Agreement and is not assigned to the Licensee. There shall be a lock-in period of three
      months, and the License Period shall be eleven months from the commencement date.
    `;
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("leave_and_license");
  });

  it("detects an 'Offer of Employment' as job_offer_letter, with the title phrase carrying real weight", () => {
    const text =
      "This letter confirms our Offer of Employment for the role of Analyst. Your date of joining " +
      "will be 1st June 2026, subject to a notice period of 30 days and a probation period of three " +
      "months. Your CTC will be Rs. 8,00,000 per annum.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("job_offer_letter");
    // Without "offer of employment" in the signature, the body concepts alone would still type
    // this correctly but only reach 0.56 — the floor pins the title phrase's own contribution.
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects a 'Confidentiality Agreement' as nda, with the title phrase carrying real weight", () => {
    const text =
      "This Confidentiality Agreement is entered into between the Disclosing Party and the " +
      "Receiving Party. Confidential Information disclosed under this Agreement is subject to " +
      "confidentiality obligations that survive termination.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("nda");
    // Without "confidentiality agreement" in the signature, the body concepts alone would still
    // type this correctly but only reach 0.69 — the floor pins the title phrase's own contribution.
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("detects a 'Privacy Notice' as privacy_policy, with the title phrase carrying real weight", () => {
    const text =
      "This Privacy Notice explains how we collect and use your personal data. We act as a Data " +
      "Fiduciary and you are the Data Principal for the purposes of this Notice, which also " +
      "explains our use of cookies.";
    const result = detectDocumentType(text);
    expect(result.documentType).toBe("privacy_policy");
    // Without "privacy notice" in the signature, the body concepts alone would still type this
    // correctly but only reach 0.53 — the floor pins the title phrase's own contribution.
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });
});

describe("detectDocumentType — deterministic", () => {
  it("returns the exact same result for the same input, every call", () => {
    const text = loadFixtureText("privacy_policy.txt");
    const first = detectDocumentType(text);
    const second = detectDocumentType(text);
    expect(second).toEqual(first);
  });
});
