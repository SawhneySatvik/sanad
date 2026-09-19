import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { classify } from "@/server/orchestrator/classify";
import { MAX_SPECIALISTS } from "@/server/orchestrator/config";
import type { OrchestratorDocumentInput } from "@/server/orchestrator/types";

function doc(overrides: Partial<OrchestratorDocumentInput> = {}): OrchestratorDocumentInput {
  return {
    id: "doc-1",
    canonicalText: "irrelevant for classify()",
    canonicalTextHash: "hash",
    inputMode: "text",
    ...overrides,
  };
}

describe("classify", () => {
  // Same network-call-spy pattern used for every zero-LLM-call contract in this codebase.
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let httpsRequestSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    httpsRequestSpy = vi.spyOn(https, "request");
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpsRequestSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    httpsRequestSpy.mockRestore();
  });

  // This specific assertion can never fail on its own — classify() takes no LlmClient parameter,
  // so a call count of 0 is guaranteed by the call site, not by classify()'s internals. Kept as a
  // structural documentation check; the falsifiable proof is the fetch/https.request spy above.
  it("makes zero LLM calls", () => {
    const client = new FakeLlmClient({ defaultResponse: { data: { answer: "unused" } } });
    classify("my landlord won't return my security deposit");
    expect(client.callCount).toBe(0);
  });

  it("routes a tenancy query to the tenancy specialist", () => {
    const result = classify("my landlord is trying to evict me without notice, what about my security deposit?");
    expect(result.kind).toBe("legal");
    if (result.kind === "legal") {
      expect(result.domains[0].id).toBe("tenancy");
    }
  });

  it("routes an employment query to the employment specialist", () => {
    const result = classify("my employer gave me an offer letter with a 90-day probation period");
    expect(result.kind).toBe("legal");
    if (result.kind === "legal") expect(result.domains[0].id).toBe("employment");
  });

  it("a query matching 3+ domains still dispatches exactly MAX_SPECIALISTS worth of ranked domains at the top", () => {
    const query =
      "I have questions about my employment offer letter notice period, my rental agreement landlord dispute, " +
      "an NDA confidentiality agreement I signed, and freelance service agreement payment terms.";
    const result = classify(query);
    expect(result.kind).toBe("legal");
    if (result.kind !== "legal") return;
    // At least 4 domains score here (employment, tenancy, contracts_nda, freelance).
    expect(result.domains.length).toBeGreaterThanOrEqual(3);
    // The caller (run-orchestrator.ts) truncates to MAX_SPECIALISTS — asserted precisely in
    // run-orchestrator's own fan-out-cap test; this test just proves classify() itself surfaces
    // enough ranked domains for that cap to matter.
    expect(result.domains.length).toBeGreaterThan(MAX_SPECIALISTS);
  });

  it("falls back to general_legal for a query in an untuned legal area (e.g. divorce)", () => {
    const result = classify("I want to file for divorce and need to understand child custody rules");
    expect(result.kind).toBe("legal");
    if (result.kind === "legal") expect(result.domains[0].id).toBe("general_legal");
  });

  it("returns non_legal for a query with a clear non-legal signal and no attached document", () => {
    const result = classify("Can you write me a short poem about the rain?");
    expect(result).toEqual({ kind: "non_legal" });
  });

  it("returns non_legal for unrelated small talk", () => {
    const result = classify("what's a good recipe for banana bread?");
    expect(result).toEqual({ kind: "non_legal" });
  });

  it("a document attached with a tuned documentType boosts its specialist even with generic query text", () => {
    const result = classify("what does clause 4 mean?", [doc({ documentType: "nda" })]);
    expect(result.kind).toBe("legal");
    if (result.kind === "legal") expect(result.domains[0].id).toBe("contracts_nda");
  });

  it("a document with a documentType matching general_legal's own affinity (generic) still routes there", () => {
    const result = classify("what does clause 4 mean?", [doc({ documentType: "generic" })]);
    expect(result.kind).toBe("legal");
    if (result.kind === "legal") expect(result.domains[0].id).toBe("general_legal");
  });

  it("a document attached with a documentType matching NO specialist's affinity still avoids non_legal (bare fallback)", () => {
    const result = classify("what does clause 4 mean?", [doc({ documentType: "totally_unknown_type" })]);
    expect(result).toEqual({ kind: "legal", domains: [{ id: "general_legal", score: 1 }] });
  });

  it("a citation to an unrelated document (no documentType) with a non-legal-sounding query still avoids non_legal when grounded", () => {
    const result = classify("write me a poem", [doc({ documentType: null })]);
    expect(result.kind).toBe("legal");
  });

  it("an ambiguous query attached to a document is never redirected even if it also carries a non-legal signal", () => {
    // Grounded mode always skips the non-legal check entirely — there is a legal document in
    // context regardless of what this turn's question text alone reads like.
    const result = classify("can you suggest a recipe", [doc({ documentType: "nda" })]);
    expect(result.kind).toBe("legal");
    if (result.kind === "legal") expect(result.domains[0].id).toBe("contracts_nda");
  });
});

describe("classify — inflection tolerance", () => {
  it("matches a keyword's plural form ('contracts' matches whole-word 'contract')", () => {
    const result = classify("Are automatic renewal clauses in service contracts enforceable in India?");
    expect(result.kind).toBe("legal");
  });

  it("still does not match 'nda' inside 'agenda' — inflection does not weaken the base boundary check", () => {
    // No specialist scores here (contracts_nda's "nda" keyword correctly ignores "agenda"), and
    // the sentence carries no non-legal signal either, so it lands on the ambiguous-query default
    // (general_legal, score exactly 1) rather than contracts_nda.
    const result = classify("Can you add this to the agenda for our next meeting?");
    expect(result).toEqual({ kind: "legal", domains: [{ id: "general_legal", score: 1 }] });
  });

  it("does not let a short keyword's inflected form collide with an unrelated common word (fir -> fired)", () => {
    // "fir" (the FIR/police-report acronym, general_legal) is short enough that inflection is
    // deliberately not applied to it — otherwise "fired" (job termination, unrelated) would
    // spuriously match. A score of exactly 1 (the ambiguous-query default) rather than 3 (general_
    // legal's own "fir" weight) proves "fir" did not fire on this sentence.
    const result = classify("My favourite forward got fired by the club before the season even started.");
    expect(result).toEqual({ kind: "legal", domains: [{ id: "general_legal", score: 1 }] });
  });

  it("matches -ing/-ed inflections of a longer keyword (deposit -> depositing/deposited)", () => {
    const depositing = classify("If I am depositing extra money as security, do I get it back later?");
    const deposited = classify("The amount I deposited as security has not been returned.");
    expect(depositing.kind).toBe("legal");
    expect(deposited.kind).toBe("legal");
  });
});

/**
 * A refused legal question is a worse outcome than a disclaimed non-legal one answered as general
 * information, so `non_legal` now requires POSITIVE evidence a query is off-topic; an ambiguous
 * query with no signal either way answers as general_legal instead of redirecting. This changes
 * what several existing sentences classify as (an "agenda" scheduling question, or an ambiguous
 * "fired" mention with no other legal keyword, both now land on general_legal rather than
 * non_legal) — that shift IS the intended behavior, not a regression; see the tests above for
 * both of those cases updated accordingly.
 */
describe("classify — false-non-legal rate on legal questions with no obvious keyword", () => {
  // Unchanged from the prior held-out set: 20 questions across all 5 tuned domains plus
  // general_legal, natural Indian-context phrasing, written independently of any fixture file.
  const LEGAL_QUESTIONS_20 = [
    "Are automatic price hikes in a gym membership contract enforceable without prior notice to members?",
    "My interior designer never delivered the agreed drawings on time — can I claim any compensation from him?",
    "If a startup terminates an employee's ESOPs after they resign, is that legally valid?",
    "How is liability decided if a food delivery rider gets into an accident while working?",
    "Can a builder be held liable for structural defects discovered three years after possession?",
    "Is a verbal promise from my broker about a lower commission legally binding if the written agreement says otherwise?",
    "My salon charges a late fee if I cancel an appointment within two hours — is that clause valid?",
    "Can an apartment association's bylaws override what's written in my sale deed?",
    "If a wedding photographer breaches the contract by not showing up, what compensation can I claim?",
    "Is it legal for an app to keep charging my card after I cancel my subscription?",
    "Can my co-founder be held liable for debts the company took on without my knowledge?",
    "Are penalty clauses for late delivery in a vendor contract enforceable in India?",
    "My car insurance company is refusing to pay damages after an accident — what are my options?",
    "Is a franchise agreement's non-compete clause enforceable after the franchise ends?",
    "Can HR share my medical leave details with other employees without my consent?",
    "If my landlord's agent terminated my lease early without proper notice, can I claim damages?",
    "My bank keeps charging a penalty clause for a loan I already closed — who is liable?",
    "Can a housing society disconnect my water supply as a penalty for unpaid maintenance dues?",
    "Is an online seller liable if the product delivered doesn't match what was advertised?",
    "My ex-employer is refusing to pay my final settlement — what compensation am I entitled to?",
  ];

  // Layperson phrasing with no legal vocabulary at all — no "enforceable", "liable",
  // "compensation", "clause". The last one reproduces a live-validation miss verbatim (a shutting
  // business keeping a paid fee).
  const LEGAL_QUESTIONS_10_NO_JARGON = [
    "The gym closed early and won't give me back what I already paid for the rest of the year.",
    "My old flatmate is refusing to hand back the money I gave him when we moved in together.",
    "My manager let me go the same day without any warning — is that even allowed?",
    "I finished the work but the client is ghosting me and won't send the payment.",
    "My landlord walked into my room while I was out, without telling me first.",
    "Someone at my old company shared my address and phone number with people outside the company.",
    "The salon kept charging my card every month even after I told them to stop.",
    "My roommate moved out and left me to cover the whole bill even though both our names are on it.",
    "I was told I'd get paid within a week, and it's been two months with nothing.",
    "The centre is shutting next week and they will keep this month's fee — can they do that?",
  ];

  it(`none of ${LEGAL_QUESTIONS_20.length} keyword-light legal questions are classified non_legal`, () => {
    const falseNonLegal = LEGAL_QUESTIONS_20.filter((q) => classify(q).kind === "non_legal");
    expect(falseNonLegal, `wrongly classified non_legal: ${JSON.stringify(falseNonLegal, null, 2)}`).toEqual([]);
  });

  it(`none of ${LEGAL_QUESTIONS_10_NO_JARGON.length} jargon-free layperson legal questions are classified non_legal`, () => {
    const falseNonLegal = LEGAL_QUESTIONS_10_NO_JARGON.filter((q) => classify(q).kind === "non_legal");
    expect(falseNonLegal, `wrongly classified non_legal: ${JSON.stringify(falseNonLegal, null, 2)}`).toEqual([]);
  });
});

describe("classify — still redirects genuinely non-legal questions", () => {
  // Own wording, spanning the same KINDS as tests/fixtures/live-validation/ask/non_legal.json
  // (recipe, sports trivia, travel itinerary, coding, a gift suggestion) plus other off-topic
  // categories (weather, entertainment trivia, maths homework).
  const NON_LEGAL_QUESTIONS = [
    "What's a simple recipe for making vegetable pulao?",
    "Which country won the most medals at the last Olympics?",
    "Can you suggest a 4-day itinerary for visiting Goa?",
    "How do I sort an array in JavaScript?",
    "What should I get my best friend as a birthday gift?",
    "What's the weather forecast for Bangalore this weekend?",
    "Who played the villain in the latest superhero movie?",
    "How do I solve a quadratic equation for algebra homework?",
    "What's a good caption for my New Year Instagram photo?",
    "Which team won the last T20 World Cup?",
    "How many overs are there in a one-day cricket match?",
    "What's the best trekking route to Triund in Himachal?",
    "How do I bake a chocolate cake without an oven?",
    "Can you write me a short poem about the monsoon?",
    "What's a good workout routine for building strength at home?",
    "How do I reverse a string in Python?",
  ];

  it(`all ${NON_LEGAL_QUESTIONS.length} genuinely non-legal questions are still classified non_legal`, () => {
    const falseLegal = NON_LEGAL_QUESTIONS.filter((q) => classify(q).kind !== "non_legal");
    expect(falseLegal, `wrongly classified legal: ${JSON.stringify(falseLegal, null, 2)}`).toEqual([]);
  });

  it("a sports question mentioning 'penalty' is not caught by any legal keyword", () => {
    // "penalty" alone is deliberately absent from every keyword list (it's a sports term as much
    // as a legal one) — this isolates that specific decision.
    const result = classify("Who won the penalty shootout in the 2023 ISL final?");
    expect(result).toEqual({ kind: "non_legal" });
  });
});

describe("classify — everyday non-legal categories (gifts, festivals, relationships, health, hobbies, trivia, homework)", () => {
  // Own wording, one or more per category. Includes the live-validation dry-run miss ("gift my
  // sister for Raksha Bandhan") as the first entry, fixed by the festival/occasion-name category
  // rather than by matching that sentence specifically — bare "gift" is never a signal (see the
  // comment on the signal list; "gifted"/"gift deed" are real property-law terms).
  const EVERYDAY_NON_LEGAL_QUESTIONS = [
    "What should I gift my sister for Raksha Bandhan?",
    "What can I get my parents for their wedding anniversary?",
    "How should I wish my friend a happy Diwali over text?",
    "My crush hasn't replied to my message in two days, what should I do?",
    "My girlfriend and I keep arguing about small things, any relationship advice?",
    "What's a good diet plan for losing weight before summer?",
    "Do you have a home remedy for a sore throat?",
    "What's a nice honeymoon destination in India during winter?",
    "Can you suggest a fun hobby I can start this weekend?",
    "Any tips for growing tomatoes in a balcony garden?",
    "What's a good camera setting for photography at night?",
    "What's a fun trivia question I can ask at a party?",
    "Which animal holds the world record for the fastest land speed?",
    "What are some good study tips before a board exam?",
    "I need ideas for a school project on the solar system.",
  ];

  it(`all ${EVERYDAY_NON_LEGAL_QUESTIONS.length} everyday non-legal questions are classified non_legal`, () => {
    const falseLegal = EVERYDAY_NON_LEGAL_QUESTIONS.filter((q) => classify(q).kind !== "non_legal");
    expect(falseLegal, `wrongly classified legal: ${JSON.stringify(falseLegal, null, 2)}`).toEqual([]);
  });

  it("overlap words keep their legal routes: a gift-DEED property question is not caught by the gifts category", () => {
    // "gifted"/"gift deed" describe a real (if uncommon) way to transfer property in India — bare
    // "gift" is deliberately not a non-legal signal so this still routes to general_legal, not
    // non_legal, purely via the ambiguous-query default (no specific "gift deed" keyword either).
    const result = classify("My father gifted our ancestral house to me — do I still need to register a gift deed?");
    expect(result.kind).toBe("legal");
  });

  it("overlap words keep their legal routes: 'landlord', 'salary' and 'deposit' still score their specialists even near a festival/greeting word", () => {
    expect(classify("My landlord raised my rent right before Diwali, is that allowed?").kind).toBe("legal");
    expect(classify("My salary was cut this month with no notice, right after my birthday").kind).toBe("legal");
    expect(classify("My deposit was withheld even though I gave proper notice before Diwali").kind).toBe("legal");
  });

  it("a greeting mentioning a legal-flavoured word is legitimately ambiguous — not asserted either way", () => {
    // Mirrors tests/fixtures/live-validation/ask/non_legal.json's own NL-Q6, marked ambiguous and
    // excluded from that fixture's redirect-rate check for the same reason: "landlord" alone
    // scores tenancy directly (matched.length > 0), so this returns "legal" — a defensible
    // outcome for a non-legal message that happens to name a legal relationship, not a bug.
    const result = classify("Can you help me write a polite WhatsApp message wishing my landlord a happy Diwali?");
    expect(result.kind).toBe("legal");
  });
});

describe("classify — the fixture routing bar (read-only reference, never tuned on)", () => {
  // The 30 non-grounded ("general"/"routing" kind) questions across tests/fixtures/live-validation/
  // ask/*.json, read here purely to measure routing quality, scored with no document attached — a
  // text-only measurement, not comparable to the live-validation report's grounded routing score.
  const ROUTING_BAR = [
    { file: "freelance_service_agreement.json", question: "As a freelancer in India, when do I need to register for GST?", expected: "freelance" },
    { file: "freelance_service_agreement.json", question: "A client has not paid my invoice for three months. What can I do as a freelance designer?", expected: "freelance" },
    { file: "freelance_service_agreement.json", question: "Is the 12-month non-compete in this agreement enforceable against me?", expected: "freelance" },
    {
      file: "freelance_service_agreement.json",
      question: "Can my client stop me from showing their project in my portfolio if the contract says nothing about it?",
      expected: "freelance",
    },
    {
      file: "freelance_service_agreement.json",
      question:
        "The startup I freelance for wants to hire me full-time with a 90-day notice period. What should I check in the offer letter before signing?",
      expected: "employment",
    },
    { file: "generic.json", question: "Are automatic renewal clauses in service contracts enforceable in India?", expected: "contracts_nda" },
    { file: "generic.json", question: "My co-working space is refusing to return my deposit. Can I approach the consumer forum?", expected: "general_legal" },
    {
      file: "generic.json",
      question: "The centre's CCTV recorded me and they gave the footage to my former business partner. Is that a violation of my privacy under the DPDP Act?",
      expected: "privacy",
    },
    {
      file: "generic.json",
      question:
        "I'm a freelancer renting a desk at a co-working space, and their membership agreement needs 60 days' notice to stop auto-renewal. Is that clause fair?",
      expected: "contracts_nda",
    },
    { file: "generic.json", question: "My co-working operator locked my desk and is holding my laptop until I pay their dues. Can I file a police complaint?", expected: "general_legal" },
    { file: "job_offer_letter.json", question: "Is a non-compete clause in an employment contract enforceable in India after I resign?", expected: "employment" },
    {
      file: "job_offer_letter.json",
      question: "Can my previous employer refuse to give me a relieving letter because I did not serve my full notice period?",
      expected: "employment",
    },
    {
      file: "job_offer_letter.json",
      question: "The company also wants me to sign a separate NDA before joining. Is that normal, and does it change anything in this offer?",
      expected: "employment",
    },
    {
      file: "job_offer_letter.json",
      question:
        "I am joining a company as a full-time employee but still have one freelance client project to finish. Can my offer letter's clause on other paid assignments stop me from completing it?",
      expected: "employment",
    },
    {
      file: "job_offer_letter.json",
      question: "HR is asking for my last three payslips and bank statements for background verification. How long are they allowed to keep this data?",
      expected: "privacy",
    },
    {
      file: "leave_and_license.json",
      question: "Is it compulsory to register a leave and license agreement in Maharashtra, and who usually pays the stamp duty?",
      expected: "tenancy",
    },
    { file: "leave_and_license.json", question: "My landlord in Pune has not returned my security deposit two months after I vacated. What can I do?", expected: "tenancy" },
    {
      file: "leave_and_license.json",
      question: "The licensor wants a copy of my Aadhaar and my employer's details for police verification. Do I have to give them, and what can he do with that data?",
      expected: "tenancy",
    },
    { file: "leave_and_license.json", question: "I work from my rented flat as a freelance graphic designer. Can my landlord stop me from running my business from home?", expected: "tenancy" },
    {
      file: "leave_and_license.json",
      question: "My employer is transferring me to Hyderabad, but my flat in Kharghar has a lock-in period until May. Do I still have to pay rent for the remaining months?",
      expected: "tenancy",
    },
    { file: "nda.json", question: "What is the difference between a mutual NDA and a one-way NDA?", expected: "contracts_nda" },
    {
      file: "nda.json",
      question: "Are liquidated damages clauses enforceable in India, or does the other side still have to prove its actual loss?",
      expected: "contracts_nda",
    },
    { file: "nda.json", question: "The NDA says we may receive Brightwater's customer data. What are our duties under the DPDP Act for that data?", expected: "privacy" },
    { file: "nda.json", question: "One of our designers is leaving to join a competitor. Can we stop her from working there using the NDA she signed with us?", expected: "employment" },
    {
      file: "nda.json",
      question: "A client wants me, as an individual freelancer, to sign their NDA personally instead of through my LLP. Does it bind me personally?",
      expected: "contracts_nda",
    },
    { file: "privacy_policy.json", question: "What rights do I have over my personal data under the DPDP Act, 2023?", expected: "privacy" },
    { file: "privacy_policy.json", question: "A company leaked my phone number in a data breach. Are they required to tell me?", expected: "privacy" },
    {
      file: "privacy_policy.json",
      question: "NestNagar shared my rent agreement with my landlord's broker without asking me. Can I complain about this, and to whom?",
      expected: "privacy",
    },
    {
      file: "privacy_policy.json",
      question: "My landlord installed a CCTV camera facing my door and shares the footage in the society WhatsApp group. Is he allowed to do this?",
      expected: "privacy",
    },
    { file: "privacy_policy.json", question: "The rent-payment app I use charged a hidden processing fee on my rent. Can I file a consumer complaint against the app?", expected: "general_legal" },
  ];

  it("none of the 30 routing-bar questions are classified non_legal (every one has a legal reading)", () => {
    const nonLegal = ROUTING_BAR.filter(({ question }) => classify(question).kind === "non_legal");
    expect(nonLegal, `wrongly classified non_legal: ${JSON.stringify(nonLegal, null, 2)}`).toEqual([]);
  });

  it("reports the top-choice routing hit rate (informational — not enforced by tuning keywords)", () => {
    let hits = 0;
    const misses: string[] = [];
    for (const { file, question, expected } of ROUTING_BAR) {
      const result = classify(question);
      const top = result.kind === "legal" ? result.domains[0]?.id : "non_legal";
      if (top === expected) hits++;
      else misses.push(`[${file}] expected=${expected} got=${top}: ${question}`);
    }
    // Not a pass/fail bar: logged so a routing-priority change can be measured against it, not
    // enforced as an assertion here.
    console.log(`routing-bar top-choice hits: ${hits}/${ROUTING_BAR.length}`, misses);
    expect(hits).toBeGreaterThan(0);
  });
});
