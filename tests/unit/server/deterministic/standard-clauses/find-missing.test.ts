import { describe, expect, it } from "vitest";
import type { DocumentTypeId } from "@/server/deterministic/document-type-registry";
import { MAX_EXTRACTED_CHARS } from "@/server/deterministic/extract/constants";
import {
  findMissingStandardClauses,
  MIN_WORDS,
  STANDARD_CLAUSES_BY_DOCUMENT_TYPE,
  STANDARD_CLAUSES_VERSION,
  withoutModelCoveredGaps,
} from "@/server/deterministic/standard-clauses";

// Special characters are built from code points, never written as `\uXXXX` escapes: some editing
// tools turn those into the literal character, and the test would silently check the wrong input.
const cp = (...points: number[]) => String.fromCodePoint(...points);

type TunedType = Exclude<DocumentTypeId, "generic" | "grounded_response">;
const TUNED_TYPES: TunedType[] = ["leave_and_license", "job_offer_letter", "nda", "privacy_policy", "freelance_service_agreement"];

// Bland prose that matches no presence phrase of any type; every test asserts that before relying on it.
const NEUTRAL_PARAGRAPH =
  "This paper records the particulars settled between the persons named in it. Each person has read every page " +
  "with care and signs it in good faith. The headings are for ease of reading only. Words in the singular cover " +
  "the plural where the context allows. Nothing here is meant to be read against either person. A copy of this " +
  "paper is kept by each person named above.";
const NEUTRAL = Array.from({ length: 4 }, () => NEUTRAL_PARAGRAPH).join("\n\n");

const itemIds = (type: TunedType) => STANDARD_CLAUSES_BY_DOCUMENT_TYPE[type].map((item) => item.id);
const gapIds = (type: DocumentTypeId, text: string) =>
  findMissingStandardClauses(type, text).map((gap) => gap.id.slice(type.length + 1));
const withClause = (clause: string) => `${NEUTRAL}\n\n${clause}\n\n${NEUTRAL_PARAGRAPH}`;

// Ordinary Indian drafting for each protection, with synonyms, plurals and punctuation the phrases do not spell out.
const PRESENT_SAMPLES: Record<TunedType, Record<string, string[]>> = {
  leave_and_license: {
    security_deposit_refund: [
      "The interest-free security deposit shall be refunded to the Licensee within 30 days of vacating.",
      "The Licensor shall pay back the deposit, less arrears, when the Licensee hands over the flat.",
    ],
    termination_notice: [
      "Either party may end this agreement by giving one month's notice.",
      "The Licensee may vacate earlier on thirty (30) days' notice in writing.",
    ],
    rent_due_date: ["The license fee is payable on or before the 5th of every English calendar month."],
    rent_escalation: ["The license fee shall be enhanced by 5% at the time of every renewal."],
    renewal: ["This agreement may be renewed for a further period of eleven months by mutual consent."],
    maintenance_and_repairs: ["Minor repairs shall be carried out by the Licensee at his own cost."],
    utilities_and_charges: ["The Licensee shall pay the electricity and water bills directly to the authorities."],
    registration_and_stamp_duty: [
      "The stamp duty and registration charges shall be shared equally by both parties.",
      "This agreement shall be registered with the Sub-Registrar of Assurances, Haveli.",
    ],
    subletting: ["The Licensee shall not sub-let the premises or any part thereof.", "Subletting is not permitted."],
    landlord_entry: ["The Licensor may inspect the premises at a reasonable hour with prior intimation."],
    fixtures_inventory: ["The list of fixtures and fittings provided is annexed as Schedule II."],
  },
  job_offer_letter: {
    probation: ["You will be on probation for six months from your date of joining."],
    notice_period: [
      "Either side may end the employment with sixty days' notice or salary in lieu thereof.",
      "Your notice period after confirmation will be 2 months.",
    ],
    salary_breakup: ["The CTC break-up (Basic, HRA and special allowance) is given in Annexure B."],
    working_hours: ["Normal working hours are 9:30 am to 6:30 pm, Monday to Friday."],
    leave_entitlement: ["You will be entitled to 18 leaves per calendar year as per the company leave policy."],
    termination_grounds: ["The Company may terminate your employment for misconduct without notice."],
    confidentiality: ["You shall keep all Company information strictly confidential."],
    statutory_benefits: ["You will be covered under the Provident Fund and Gratuity schemes as applicable."],
    place_of_work: ["Your place of work will be Pune, and you may be transferred to any of our offices in India."],
  },
  nda: {
    definition_of_confidential_information: ['"Confidential Information" means all non-public business information.'],
    exclusion_public_information: ["These obligations do not apply to information in the public domain."],
    exclusion_prior_or_third_party: ["Nor to information already known to the Receiving Party before disclosure."],
    exclusion_independent_development: ["Nor to information independently developed by the Receiving Party."],
    compelled_disclosure: ["Disclosure required by law or by a court order is permitted after notice."],
    duration_of_obligations: ["These obligations survive for three years after termination."],
    return_or_destruction: ["On request, the Receiving Party shall return or destroy all Confidential Information."],
    remedies: ["The Disclosing Party is entitled to seek injunctive relief for any breach."],
    permitted_recipients: ["Disclosure may be made to employees and advisers on a need-to-know basis."],
    purpose_limitation: ["Information shall be used solely for evaluating the proposed transaction."],
    governing_law_and_disputes: ["Disputes shall be referred to arbitration seated at Mumbai."],
  },
  privacy_policy: {
    data_collected: ["We collect your name, mobile number and email address."],
    purposes_of_processing: ["We use your data to provide the Services and to prevent fraud."],
    consent_withdrawal: ["You may withdraw your consent at any time from the settings page."],
    sharing_and_processors: ["We share data with our data processors, such as payment gateways."],
    cross_border_transfer: ["Your data may be processed on servers located outside India."],
    retention: ["We retain your data only as long as necessary for these purposes."],
    security_and_breach: ["We protect your data with encryption and will notify you of any breach."],
    data_principal_rights: ["You have the right to access, correct and erase your personal data."],
    nomination: ["You may nominate a person to exercise your rights in the event of death or incapacity."],
    grievance_redressal: ["Complaints may be sent to our Grievance Officer at grievance@example.in."],
    childrens_data: ["We do not knowingly process data of children under 18 without parental consent."],
    policy_changes: ["We will notify you of material changes to this policy by email."],
  },
  freelance_service_agreement: {
    scope_of_work: ["The Deliverables are listed in the Statement of Work at Annexure A."],
    payment_timeline: ["Each invoice shall be payable within fifteen days of receipt."],
    late_payment: ["Overdue amounts carry interest at 1.5% per month."],
    ip_transfer_on_payment: ["Rights in the work pass to the Client upon receipt of full payment."],
    revision_limits: ["The fee covers two rounds of revisions; further changes are billed separately."],
    acceptance: ["The Client shall confirm acceptance of each deliverable within 7 days of delivery."],
    termination: ["Either party may terminate this Agreement on 14 days' written notice."],
    payment_on_termination: [
      "On cancellation, the Client shall pay for work done up to that date.",
      "If the project is cancelled, work in progress is billed at the hourly rate.",
    ],
    liability_cap: ["The Freelancer's aggregate liability is limited to the fees paid under this Agreement."],
    dispute_resolution: ["Any dispute shall be resolved by arbitration under the Arbitration and Conciliation Act, 1996."],
    taxes: ["All fees are exclusive of GST; the Client may deduct TDS as required."],
    confidentiality: ["The Freelancer shall keep the Client's business information confidential."],
  },
};

describe("findMissingStandardClauses — absence", () => {
  it.each(TUNED_TYPES)("flags every %s item in a document that mentions none of them", (type) => {
    const gaps = findMissingStandardClauses(type, NEUTRAL);

    expect(gaps.map((gap) => gap.id)).toEqual(itemIds(type).map((id) => `${type}.${id}`));
  });

  it("returns gaps shaped like a quote-less missing_clause finding, marked as a checklist result", () => {
    const [gap] = findMissingStandardClauses("leave_and_license", NEUTRAL);

    expect(gap).toEqual({
      id: "leave_and_license.security_deposit_refund",
      category: "missing_clause",
      quote: null,
      verification: null,
      topic: "Security deposit refund",
      explanation: STANDARD_CLAUSES_BY_DOCUMENT_TYPE.leave_and_license[0].explanation,
      provenance: "standard_clause_checklist",
      checklistVersion: STANDARD_CLAUSES_VERSION,
    });
    expect(Object.keys(gap)).not.toContain("status");
  });

  it("returns the same gaps for the same input", () => {
    const text = withClause(PRESENT_SAMPLES.nda.remedies[0]);

    expect(findMissingStandardClauses("nda", text)).toEqual(findMissingStandardClauses("nda", text));
  });
});

describe("findMissingStandardClauses — presence", () => {
  for (const type of TUNED_TYPES) {
    it(`covers every ${type} item with at least one sample`, () => {
      expect(Object.keys(PRESENT_SAMPLES[type]).sort()).toEqual(itemIds(type).sort());
    });

    for (const [itemId, samples] of Object.entries(PRESENT_SAMPLES[type])) {
      it.each(samples)(`does not flag ${type}.${itemId} when the text says: %s`, (sample) => {
        expect(gapIds(type, NEUTRAL)).toContain(itemId);

        expect(gapIds(type, withClause(sample))).not.toContain(itemId);
      });
    }
  }
});

describe("findMissingStandardClauses — matching", () => {
  it("ignores case, hyphens and line breaks inside a phrase", () => {
    expect(gapIds("leave_and_license", withClause("SUB-LETTING IS NOT ALLOWED."))).not.toContain("subletting");
    expect(gapIds("leave_and_license", withClause("stamp\nduty is payable by the Licensee."))).not.toContain(
      "registration_and_stamp_duty",
    );
  });

  it("reads a possessive with a curly apostrophe like a plain one", () => {
    const curly = `Either party may end this agreement on one month${cp(0x2019)}s notice.`;

    expect(gapIds("leave_and_license", withClause(curly))).not.toContain("termination_notice");
  });

  it("treats singular and plural forms alike", () => {
    expect(gapIds("leave_and_license", withClause("Structural REPAIRS are the owner's."))).not.toContain(
      "maintenance_and_repairs",
    );
    expect(gapIds("nda", withClause("All remedies at law remain available."))).not.toContain("remedies");
    expect(gapIds("freelance_service_agreement", withClause("All applicable taxes are borne by the Client."))).not.toContain(
      "taxes",
    );
  });

  it("treats any number, in digits or words, as the same number", () => {
    expect(gapIds("leave_and_license", withClause("It ends on a notice of thirty days."))).not.toContain(
      "termination_notice",
    );
    expect(gapIds("job_offer_letter", withClause("You will get 24 leaves every year."))).not.toContain(
      "leave_entitlement",
    );
  });

  it("reads through ligatures, soft hyphens and words hyphenated across a line break", () => {
    const ligature = `All information is con${cp(0xfb01)}dential.`;
    const softHyphen = `Main${cp(0xad)}tenance of the flat is the Licensee's.`;
    const lineBreak = "The Licensee shall bear the cost of main-\ntenance.";

    expect(ligature).not.toContain("fi");
    expect(softHyphen).not.toContain("Maintenance");
    expect(gapIds("job_offer_letter", withClause(ligature))).not.toContain("confidentiality");
    expect(gapIds("leave_and_license", withClause(softHyphen))).not.toContain("maintenance_and_repairs");
    expect(gapIds("leave_and_license", withClause(lineBreak))).not.toContain("maintenance_and_repairs");
  });

  it("matches whole words only, never a phrase inside a longer word", () => {
    const text = withClause("The syntax of this standard PDF is fixed in the calendar.");

    expect(gapIds("freelance_service_agreement", text)).toContain("taxes");
    expect(gapIds("job_offer_letter", text)).toContain("statutory_benefits");
    expect(gapIds("job_offer_letter", text)).toContain("confidentiality");
  });
});

describe("findMissingStandardClauses — when it claims nothing", () => {
  it("returns [] for generic and grounded_response, whatever the text", () => {
    expect(findMissingStandardClauses("generic", NEUTRAL)).toEqual([]);
    expect(findMissingStandardClauses("grounded_response", NEUTRAL)).toEqual([]);
  });

  it(`returns [] below ${MIN_WORDS} words and checks from ${MIN_WORDS} on`, () => {
    const words = (n: number) => Array.from({ length: n }, () => "page").join(" ");

    expect(findMissingStandardClauses("nda", words(MIN_WORDS - 1))).toEqual([]);
    expect(findMissingStandardClauses("nda", words(MIN_WORDS))).toHaveLength(itemIds("nda").length);
  });

  it("returns [] over the extraction size cap rather than judging a truncated text, and checks at the cap", () => {
    const atCap = NEUTRAL.repeat(Math.ceil(MAX_EXTRACTED_CHARS / NEUTRAL.length)).slice(0, MAX_EXTRACTED_CHARS);

    expect(atCap.length).toBe(MAX_EXTRACTED_CHARS);
    expect(findMissingStandardClauses("nda", atCap)).toHaveLength(itemIds("nda").length);
    expect(findMissingStandardClauses("nda", `${atCap} `)).toEqual([]);
  });

  it("returns [] when much of the text is in another script, where a protection may be written", () => {
    // Devanagari (U+0915 KA, U+0930 RA) makes up well over a tenth of the letters.
    const hindi = Array.from({ length: 200 }, () => cp(0x0915, 0x0930)).join(" ");
    const mixed = `${NEUTRAL}\n\n${hindi}`;

    expect(mixed).toMatch(/\p{Script=Devanagari}/u);
    expect(findMissingStandardClauses("leave_and_license", mixed)).toEqual([]);
  });

  it("still checks an English document with a few words in another script", () => {
    const name = cp(0x0915, 0x0930, 0x0923);

    expect(findMissingStandardClauses("leave_and_license", `${NEUTRAL}\n\n${name}`)).toHaveLength(
      itemIds("leave_and_license").length,
    );
  });
});

describe("withoutModelCoveredGaps", () => {
  const gaps = findMissingStandardClauses("leave_and_license", NEUTRAL);
  const ids = (list: { id: string }[]) => list.map((gap) => gap.id.replace("leave_and_license.", ""));

  it("keeps every gap when the model reported no missing clause", () => {
    expect(withoutModelCoveredGaps(gaps, [])).toEqual(gaps);
  });

  it("drops the gap a model-written missing_clause already covers, and only that one", () => {
    const kept = withoutModelCoveredGaps(gaps, ["The agreement does not say when the security deposit will be refunded."]);

    expect(ids(kept)).toEqual(ids(gaps).filter((id) => id !== "security_deposit_refund"));
  });

  it("does not drop a gap whose topic the model mentions only in passing", () => {
    const refundOnly = "No timeline for returning the deposit after termination with one month's notice is given.";

    const kept = ids(withoutModelCoveredGaps(gaps, [refundOnly]));

    expect(kept).not.toContain("security_deposit_refund");
    expect(kept).toContain("termination_notice");
  });

  it("matches the model's wording regardless of case and punctuation", () => {
    expect(ids(withoutModelCoveredGaps(gaps, ["No NOTICE-PERIOD is stated."]))).not.toContain("termination_notice");
  });

  it("keeps a gap it has no topic keywords for", () => {
    const unknown = { ...gaps[0], id: "leave_and_license.not_an_item" };

    expect(withoutModelCoveredGaps([unknown], ["deposit refund"])).toEqual([unknown]);
  });
});
