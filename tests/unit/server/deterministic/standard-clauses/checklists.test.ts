import { describe, expect, it } from "vitest";
import { DOCUMENT_TYPE_IDS } from "@/server/deterministic/document-type-registry";
import { STANDARD_CLAUSES_BY_DOCUMENT_TYPE } from "@/server/deterministic/standard-clauses";

const TUNED_TYPES = ["leave_and_license", "job_offer_letter", "nda", "privacy_policy", "freelance_service_agreement"] as const;
const allItems = TUNED_TYPES.flatMap((type) => STANDARD_CLAUSES_BY_DOCUMENT_TYPE[type].map((item) => ({ type, item })));

describe("STANDARD_CLAUSES_BY_DOCUMENT_TYPE", () => {
  it("has an entry for every document type id", () => {
    expect(Object.keys(STANDARD_CLAUSES_BY_DOCUMENT_TYPE).sort()).toEqual([...DOCUMENT_TYPE_IDS].sort());
  });

  it("has no checklist for generic or grounded_response", () => {
    expect(STANDARD_CLAUSES_BY_DOCUMENT_TYPE.generic).toEqual([]);
    expect(STANDARD_CLAUSES_BY_DOCUMENT_TYPE.grounded_response).toEqual([]);
  });

  it.each(TUNED_TYPES)("has 6-12 items with unique [a-z_] ids for %s", (type) => {
    const ids = STANDARD_CLAUSES_BY_DOCUMENT_TYPE[type].map((item) => item.id);

    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(ids.length).toBeLessThanOrEqual(12);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z_]+$/);
  });

  it("gives every item a topic, a presence phrase and a non-empty topic keyword group", () => {
    expect(allItems.length).toBeGreaterThan(0);
    for (const { type, item } of allItems) {
      const label = `${type}.${item.id}`;
      expect(item.topic.trim(), label).not.toBe("");
      expect(item.presence.length, label).toBeGreaterThan(0);
      expect(item.topicKeywords.length, label).toBeGreaterThan(0);
      for (const group of item.topicKeywords) expect(group.length, label).toBeGreaterThan(0);
    }
  });

  it("writes every phrase and keyword as plain lowercase ASCII words", () => {
    for (const { type, item } of allItems) {
      for (const phrase of [...item.presence, ...item.topicKeywords.flat()]) {
        expect(phrase, `${type}.${item.id}`).toMatch(/^[a-z0-9]+(?: [a-z0-9]+)*$/);
      }
    }
  });

  it("phrases every explanation as a hedged absence, with no severity ranking or advice to sign", () => {
    for (const { type, item } of allItems) {
      const label = `${type}.${item.id}`;
      expect(item.explanation, label).toMatch(/^The (agreement|letter|policy) does not appear to /);
      expect(item.explanation, label).not.toMatch(/\b(important|critical|crucial|serious|severe|risk|risky|danger|dangerous|urgent|priority)\b/i);
      expect(item.explanation, label).not.toMatch(/\b(you should|we recommend|do not sign|don't sign)\b/i);
    }
  });
});
