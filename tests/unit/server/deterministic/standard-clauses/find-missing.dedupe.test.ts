import { describe, expect, it } from "vitest";
import { findMissingStandardClauses, withoutModelCoveredGaps } from "@/server/deterministic/standard-clauses";

// A checklist gap is dropped only when a model missing_clause sentence itself claims that topic is
// absent, in a strong form with no other negator. Model text can be steered by the document it
// reads, and a duplicate costs less than a hidden gap, so every weaker or doubtful match keeps it.

const NEUTRAL_PARAGRAPH =
  "This paper records the particulars settled between the persons named in it. Each person has read every page " +
  "with care and signs it in good faith. The headings are for ease of reading only. Words in the singular cover " +
  "the plural where the context allows. Nothing here is meant to be read against either person. A copy of this " +
  "paper is kept by each person named above.";
const gaps = findMissingStandardClauses("leave_and_license", Array.from({ length: 4 }, () => NEUTRAL_PARAGRAPH).join("\n\n"));
const kept = (explanations: string[]) =>
  withoutModelCoveredGaps(gaps, explanations).map((gap) => gap.id.replace("leave_and_license.", ""));

describe("withoutModelCoveredGaps — only an absence claim on exactly that topic drops a gap", () => {
  it("the checklist reports both topics these tests use", () => {
    expect(kept([])).toEqual(expect.arrayContaining(["security_deposit_refund", "registration_and_stamp_duty"]));
  });

  it("positive: a sentence saying the topic is absent drops that gap and no other", () => {
    const result = kept(["The agreement does not say when the security deposit will be refunded."]);

    expect(result).not.toContain("security_deposit_refund");
    expect(result).toEqual(kept([]).filter((id) => id !== "security_deposit_refund"));
  });

  it("positive: one absence claim per topic drops each of those gaps", () => {
    const result = kept(["There is no mention of stamp duty.", "There is no clause on the deposit refund."]);

    expect(result).not.toContain("registration_and_stamp_duty");
    expect(result).not.toContain("security_deposit_refund");
  });

  it("negative: a missing_clause explanation that names the topic but asserts it is present keeps the gap", () => {
    expect(kept(["The security deposit will be refunded within 30 days of vacating."])).toContain("security_deposit_refund");
  });

  it("negative: an absence claim about one topic keeps the gap of another topic named in a separate sentence", () => {
    const result = kept(["The agreement has no clause on stamp duty. The security deposit will be refunded within 30 days."]);

    expect(result).not.toContain("registration_and_stamp_duty");
    expect(result).toContain("security_deposit_refund");
  });

  it("negative: one sentence naming two topics is ambiguous, so both gaps stay", () => {
    const result = kept(["There is no clause on stamp duty, although the security deposit is refundable on exit."]);

    expect(result).toContain("registration_and_stamp_duty");
    expect(result).toContain("security_deposit_refund");
  });

  it("negative: the absence word and the topic in different sentences keep the gap", () => {
    expect(kept(["No timeline is given anywhere. The deposit must be refunded on exit."])).toContain("security_deposit_refund");
  });

  it.each([
    "The agreement has no clause on the security deposit refund.",
    "The agreement does not appear to specify when the security deposit is refunded.",
    "No clause says when the deposit will be refunded.",
    "The agreement fails to specify the deposit refund date.",
  ])("positive: a strong absence claim drops the gap — %s", (sentence) => {
    expect(kept([sentence])).not.toContain("security_deposit_refund");
  });

  it.each([
    "The security deposit refund is not missing; the clause is complete and fair.",
    "Nothing is wrong with the security deposit refund clause.",
    "Nothing about the security deposit refund is missing.",
    "The security deposit refund clause is not at all missing.",
    "The security deposit refund clause is not, in fact, missing.",
    "There is no doubt the security deposit refund is covered in full.",
    "There is no question that the security deposit refund clause is present.",
    "The lease has no problem with the security deposit refund.",
    "The lease does not just mention the security deposit refund, it details it.",
    "The lease lacks a security deposit refund clause.",
    "The lease omits the security deposit refund.",
    "The security deposit refund is missing.",
    "Nothing is missing from the deposit refund clause.",
    "There is no clause that does not protect the deposit refund.",
    "The deposit must be refunded no later than 30 days after vacating.",
    "The deposit refund is no later than 30 days after vacating.",
    "Clause No. 5 covers the deposit refund.",
  ])("negative: a negated, doubtful or bare absence wording keeps the gap — %s", (sentence) => {
    expect(kept([sentence])).toContain("security_deposit_refund");
  });

  it("a line break ends a sentence as well as punctuation does", () => {
    expect(kept(["Stamp duty: not mentioned\nThe deposit will be refunded on exit"])).toEqual(
      kept([]).filter((id) => id !== "registration_and_stamp_duty"),
    );
  });
});
