# Live validation: how the real models perform

*23 September 2026.* Six curated Indian legal documents were run through the real product against live models: a leave-and-license agreement, a job offer letter, an NDA, a privacy policy, a freelance agreement and a co-working membership. Each has a hand-written answer key.

Every result below went through the production service code and the production fallback chain, over a fresh in-memory database. Every quote shown to a user was checked by `verify()` against the document's own text.

**Which model the numbers measure.** It matters for every table.
- **Understand** was measured on the **primary model** (`gemini-2.5-flash`, with thinking switched off).
- **Prepare's current version** was confirmed in a small follow-up run on the **fallback model**. The primary was out of its daily quota.
- **The standard-clause checklist** is deterministic, so it needs no model.
- **Ask, Compare and Draft** were measured almost entirely on the **fallback model** (`gemini-3.5-flash-lite`). To protect the shared free quota, the validation harness let each of these three parts send the primary only one real request:
  - In Ask, the primary answered that request, which is the one Ask answer on the primary. The harness's cap then sent the other three questions to the fallback.
  - In Compare and Draft, the primary returned its daily-quota error, so the fallback answered everything.

Detailed per-feature reports are in `docs/live-validation/`.

---

## Read this first: below threshold, weak, or not measured

1. **The co-working membership has never been analysed.** In each of the three runs, `generic` was skipped or cut off by the quota. None of its 12 required clauses has been tested.
2. **Freelance recall falls to 70% on a strict reading of the model alone.** The scoring rule credits the "no late-payment interest" gap to a model finding that is really about revision limits; the finding happens to say "delays in payment". Discounting it:
   - the freelance agreement scores 7/10 on the model alone, below the 80% bar;
   - the five-document aggregate is 49/58 (84.5%).

   The checklist's own late-payment gap covers this entry without the disputed match, and the reader is shown it. With the checklist, the freelance agreement is back to 8/10.
3. **Missing clauses were the weak spot; a deterministic checklist now covers part of it.** The checklist compares each document with the protections its type normally carries. Its gaps are shown labelled "possibly missing — not checked against the document", never as verified. Three separate lines:
   - **The model alone** found 3 of the 7 required "this protection is absent" entries. It found nothing missing in the job offer letter or the NDA.
   - **The checklist alone** found 5 of 7 in a held-out evaluation, with its rules frozen before any answer key was read. That evaluation found 1 false absence: it claimed the freelance agreement never says what is paid on termination, but clause 10.3 does. The rule was fixed afterwards, only in the direction of claiming less. Recomputed after the fix it still finds 5 of 7, with no unconfirmed gap, but that figure is on the same documents, so it is not held-out.
   - **Both together** find 5 of 7. This is recomputed: today's checklist applied to that run's saved model output. On that output neither finds the missing inventory list in the lease or the missing leave policy in the offer letter. The fallback model did find the missing inventory list in the later two-document run.

   With the checklist, the five documents score 52/58 on all required entries (also recomputed). On the model alone they score 50/58.
4. **Thinking off may cost quality, but that is not proven.** Understand now runs with Gemini's thinking switched off, which cut latency. On the two documents measured both ways, the thinking-off run scored lower:
   - recall 23/23 → 21/23;
   - missing-clause findings 4 → 2;
   - more findings that match no answer-key entry;
   - category agreement on the offer letter 15/18 → 12/18.

   This is one run per setting, and a two-entry difference is within normal run-to-run variation. **A repeated A/B is needed before deciding.**
5. **About half of Understand's findings are not in the answer key** (49%, up from 24%). This is reported, not gated. Most are real but minor clauses, for example the hybrid-working policy. It still means more reading for the user.
6. **Prepare's current version is confirmed only on the fallback model and on 2 documents.** The earlier version showed internal labels such as "F11" to users in 31 of 34 items.
   - **Current version, live on the fallback model** (`gemini-3.5-flash-lite`), on the NDA and the lease: **0 internal labels in 20 AI-written items.**
   - All 12 structural checks passed on both documents.
   - Both NDA checklist gaps flowed through: Prepare cited them in a lawyer question, under the "not checked" label and with no status.
   - It has not yet run on the primary model.
   - **Below threshold in the same run:** the fallback model's own analysis of the NDA found only 8/11 required clauses, under the 80% bar. It missed both missing carve-outs and one other clause. With the checklist it reaches 10/11.
7. **The Gemma fallback has never answered.**
   - NVIDIA NIM hangs for this account on every model.
   - OpenRouter's free Gemma comes from a shared pool that answers 429.
   - Google-hosted Gemma is intermittently unavailable (503).

   The working fallback today is the second Gemini model.
8. **Ask routing meets its bar with no slack: 24/30 (80%), measured again on the current classifier.**
   - The classifier now redirects a question as non-legal only on positive evidence. The question *"the centre is shutting next week and they will keep this month's fee — can they do that?"* is now **answered**, where it was redirected before.
   - It still goes to the general legal specialist, not the contracts one, so it remains a routing miss.
   - The five non-legal questions are still redirected (5/5).
9. **Ask, Compare and Draft are small samples on the fallback model:** 3 grounded answers and 1 general answer, 3 document pairs (8 changes), and 2 drafts. Treat them as a smoke test of quality, not a benchmark.
10. **A grounded draft carried over only 1 of 3 expected facts.** The offer letter grounded on the fixture kept the office location, but used neither the company's name nor the candidate's. It passes the bar (at least 1), but the grounding is thin.
11. **Transient network errors used to cost users about 2 minutes.** In the last Understand run, two Gemini calls failed with a network error (after 0.2s and 30s). Each request then waited out the unresponsive NIM gateway and failed; retrying succeeded both times. The fallback chain now retries the same model once on a no-response failure, and caps each model's share of the time. **This is not yet observed live.**
12. **The free Gemini quota cannot serve a demo.** It allows 20 requests per model per day. The primary's quota ran out today during an Understand run, and again during the Ask, Compare and Draft runs.

---

## Results by feature

### Understand: document analysis (primary model, thinking off; 5 of 6 documents)

| Metric | Bar | Result |
|---|---|---|
| Quotes found word for word in the document (verified) | ≥90% | **100%** (137/137; no approximate or missing quotes) |
| Required answer-key clauses found | ≥80% | **86.2%** (50/58); 84.5% with the item 2 discount |
| Findings in one of the five allowed categories | 100% | **100%** (142/142) |
| Findings matching no answer-key entry | reported | 49% (70/142) |

**Missing protections, three separately labelled lines** (the 7 required missing-clause entries of the five documents with a checklist):

| Line | Required missing clauses found | All required entries |
|---|---|---|
| The model's own findings (primary) | 3/7 | 50/58 |
| The checklist alone (deterministic) | 5/7 held-out; 5/7 recomputed after the fix, same documents, not held-out | — |
| Both (recomputed: today's checklist on that run's saved model output) | 5/7 | 52/58 (89.7%) |

**What the checklist flagged:**
- the NDA's two missing carve-outs (disclosure required by law, and independently developed information);
- the privacy policy's missing nomination right and missing children's-data provisions. The model had already reported these two, so the reader sees the model's version;
- the freelance agreement's missing late-payment interest.

The co-working membership has no checklist by design: with no known document type, no clause is "expected".

| Document | Required found | Quotes verified | Findings | Not in key | Time |
|---|---|---|---|---|---|
| Leave and license | 12/14 | 26/26 | 27 | 12 | 38 s |
| Job offer letter | 9/10 | 31/31 | 31 | 13 | 38 s (after one retry) |
| NDA | 9/11 | 25/25 | 25 | 14 | 35 s (after one retry) |
| Privacy policy | 12/13 | 34/34 | 36 | 19 | 28 s |
| Freelance agreement | 8/10 (7/10 strict) | 21/21 | 23 | 12 | 31 s |
| Co-working membership | not measured (quota) | — | — | — | — |

**Missed clauses:**
- **Leave and license:** termination for any minor breach, and the absent inventory list.
- **Offer letter:** no leave policy.
- **NDA:** both missing carve-outs.
- **Privacy policy:** discretionary breach notification.
- **Freelance agreement:** acceptance at the client's sole discretion, and open-ended withholding of "disputed" amounts.

**The trust result is strong.** Every quote Understand claimed in this run verified word for word. The One Guarantee held on real output: every `verified` badge came from `verify()`.

### Prepare: lawyer-prep questions and checklist (current version on the fallback model; 2 documents)

| Check | Result |
|---|---|
| Internal finding labels ("F11") in AI-written text | **0 in 20 items** (the earlier version leaked in 31 of 34) |
| Every question and item cites real findings of this document | 2/2 documents |
| Statuses and quoted spans come from the verifier, never the model | 2/2 |
| Findings with no quote (missing clauses, checklist gaps) cited under "possibly missing — not checked against the document", with no status | 2/2; the NDA's two checklist gaps were both cited |
| Not-legal-advice notice; every AI-written line labelled; no badge glyphs | 2/2 |

Each document produced 5 lawyer questions and 5 checklist items. Prepare took 4 s and 46 s.

The same run re-analysed the two documents on the fallback model:
- quotes verified 35/35;
- model-alone recall 8/11 on the NDA (item 6) and 14/14 on the lease;
- with the checklist, 10/11 and 14/14, so 24/25 in all. The checklist supplied the NDA's two missing carve-outs; the third miss is an ordinary clause.

This is a two-document confirmation run, not a benchmark. Its report is in `docs/live-validation/prepare-confirmation/`.

### Ask: questions about a document, and general questions (1 answer on the primary, 3 on the fallback)

| Metric | Bar | Result |
|---|---|---|
| Grounded answers: citations verified | ≥90% | **100%** (6/6 across 3 answers) |
| Grounded answers citing the passage a human marked as the answer | reported | 3/3 |
| General answers carrying no citation, status or badge | 100% | **1/1** |
| Routing to the right specialist (30 questions, classifier's top choice) | ≥80% | **80%** (24/30), no slack |
| Non-legal questions redirected without a model call | all | **5/5**, 0 model calls |

**Routing misses:**
1. The payslip-retention question went to employment instead of privacy.
2. The salary held back pending an NDA went to contracts instead of employment.
3. Liquidated damages went to general legal instead of contracts.
4. The unpaid logo went to contracts instead of freelance.
5. The co-working auto-renewal went to freelance instead of contracts.
6. The centre closing and keeping the fee went to general legal instead of contracts. It is now answered, not redirected.

Routing is deterministic and makes no model call, so it was measured locally on all 30 questions, with the current classifier. The live answers above predate the classifier change.

**Timing and sample:** answers took 2–5 seconds. Only single-specialist questions were run live; the two-specialist path, which adds a synthesis call, is not yet tested live.

### Compare: what changed between two versions (fallback model)

| Metric | Bar | Result |
|---|---|---|
| Injected changes detected (verified span on the changed line) **and** explained (the explanation names the new value) | 100% | **8/8** |

Every explanation was the model's own text, and each named the new value. For example: "the notice period … has been extended from thirty days to sixty days". Each pair took 2–3 seconds.

### Draft: generating a document (fallback model)

| Metric | Bar | Result |
|---|---|---|
| Every required section present and non-blank | 100% | **2/2** (a lease from scratch, and an offer letter grounded on the fixture) |
| A grounded draft reproduces at least one fact from its document | 100% | **1/1**, but only 1 of 3 expected facts (item 10) |

Neither draft carries any verification field. Model-written sections are labelled as AI-generated. Each draft took 3–4 seconds.

### The fallback chain

| Model | Status today |
|---|---|
| `gemini-2.5-flash` (primary) | Answers, but its 20/day free quota ran out twice today |
| `gemini-3.5-flash-lite` | **Answers.** It served 12 of 12 requests: 8 in the Ask, Compare and Draft runs (1–4 s each), and 4 in the Prepare confirmation run (4–55 s), all schema-valid |
| Gemma on Google | Intermittent 503s; no Understand-sized answer yet |
| Gemma on NVIDIA NIM | No response at all for this account |
| Gemma on OpenRouter (free) | 429 from the shared upstream pool |

---

## What live validation found, and what was fixed

None of these could be seen by the mocked test suite.

1. **Gemini rejected every structured-output schema.** It returned "400 … too many states for serving", caused by array-length limits in the schemas. Every analysis failed, and a 400 never falls back.
   - **Fixed:** the schema sent to providers is now simplified, and the limits are enforced after parsing.
   - **Confirmed live on the primary:** the Understand, Prepare and Ask schemas.
   - **Confirmed live on the fallback model only:** the Compare schema, and the lease and offer-letter Draft schemas. The primary returned its quota error before it read them.
   - **Not yet sent to any model:** the other four Draft schemas and the scanned-PDF transcription schema.
   - **This matters:** a rejection by the primary still ends a request with no fallback. Until the primary has accepted the Compare and Draft schemas, a primary 400 there would fail every such request.
2. **The provider timeout was too short.** A 45-second limit cut off 3 of 5 analyses, which take 28–45 s. Each failure then cascaded through two dead gateways, so the user waited about 91 s.
   - **Fixed:** each operation now has its own time budget (Understand 120 s, Prepare 90 s), and one deadline covers the whole fallback chain.
3. **The error message pointed at the wrong cause.** A timeout reached the user as "Too many requests", which was the last fallback's error.
   - **Fixed:** the final error now reports the real cause.
4. **Prepare showed internal finding labels ("F11") to users** in 31 of 34 items.
   - **Fixed:** they are now scrubbed.
   - **Confirmed live** on the fallback model: 0 in 20 items.
5. **The Gemma fallback gateways were dead,** so there was no working fallback at all.
   - **Fixed:** a second Gemini model with its own quota was added ahead of the Gemma gateways. Every model now has a circuit breaker, so a dead one is skipped cheaply. Measured working: this model answered every Ask, Compare and Draft request above.

Also added along the way:
- A deterministic standard-clause checklist for missing protections: 5 of 7 required gaps in its held-out evaluation, against the model's 3 of 7. Its one false absence was found and fixed in the permissive direction.
- The Ask classifier no longer redirects a question as non-legal without positive evidence.
- Provider rejection messages are now logged server-side, so a 400 is diagnosable.
- Every service now logs when it trims model output. No trimming occurred in any run.

---

## Still unmeasured, and why

Every item below comes down to the free-tier quotas: 20 requests per model per day.

- **Understand:**
  - the co-working document;
  - Understand's quality on the fallback model. Only two documents so far: 35/35 quotes verified; model-alone recall 22/25, 24/25 with the checklist. That is a small sample;
  - scanned-PDF transcription.
- **Prepare:** the current version on the primary model, and on the other four documents.
- **Ask:** the two-specialist path with a synthesis step. General questions have one sample only.
- **Draft:** 10 of the 12 curated draft prompts.
- **On the primary model:** Compare and Draft entirely, and three of the four Ask answers.

---

## Decisions and actions for you

1. **Enable Google billing** on the Gemini key. At 20 requests per model per day, the product cannot serve a demo, and a single validation run exhausts the quota.
2. **Fix or drop the dead gateways:**
   - check the NVIDIA NIM account, where chat hangs for every model;
   - add OpenRouter credits, or bring your own key, to leave the shared free pool.
3. **Two behaviour changes need your ruling:**
   - (a) A fallback model's rejection (a 4xx, or output that fails the schema) now passes the request on to the next model. The primary's rejection still stops the chain, so our own bugs stay visible.
   - (b) While a fallback could still run, the primary now gets at most 75% of each operation's time budget.
4. **Thinking on or off for Understand.** Once billing is on, run a repeated A/B; it costs about 12 requests per run.
5. **Tighten one answer-key entry.** The keywords for the freelance late-payment gap produced a false credit (item 2).
6. **Once billing is on, first send the Compare and Draft schemas to the primary.** A primary rejection there would fail every such request, with no fallback. Then **re-run the full live suite on the primary model.** Cover all six documents, the current Prepare, the Ask synthesis path and all 12 drafts. The harness is ready: `npm run validate:live -- understand|ask|compare|draft`.

---

## How the numbers were produced

**Documents.** Each document was uploaded, confirmed and extracted server-side through the real upload path. Understand then ran its full analysis. For Ask, Compare and Draft the analysis step was skipped to save quota, because those features read only the extracted text.

**Model calls.** Every call went through the production composition: per-principal and per-provider rate limits, then the fallback chain. For Ask, Compare and Draft, the harness also capped the primary at one real request per part; further attempts were refused locally and never sent.
- In Ask, the primary answered its one request.
- In Compare and Draft, it returned the daily-quota error.

**Builds.** The numbers come from three builds:
- **Understand's five-document run** used an earlier build and the previous fallback chain, before the second Gemini model and the circuit breakers existed.
- **Ask, Compare and Draft** used the current chain. No Understand or Prepare prompt, schema or service code changed between these first two builds.
- **The Prepare confirmation run**, with its two-document Understand re-analysis, used the latest build: the current chain plus the standard-clause checklist.

Ask routing was re-measured locally with the current classifier. The checklist lines for the five-document run were recomputed from the document text, with today's checklist.

**Scoring rules** (fixed in advance):
- **Recall:** each finding is matched to at most one answer-key clause.
- **Compare:** scored on a verified span on the changed line, plus an explanation naming the new value.
- **Draft:** sections are checked by the template registry's own completeness check.

**Requests sent:**
- Understand's three runs sent 29 requests.
- The Prepare confirmation run sent 4, all to `gemini-3.5-flash-lite`. 6 primary attempts were refused locally, because the primary was capped at 0 while out of quota.
- The Ask, Compare and Draft runs sent 11:
  - 8 to `gemini-3.5-flash-lite`, of a 12-request allowance;
  - 3 to the primary, one per part. One answered; two returned the daily-quota 429.
- 12 further primary attempts were deliberately refused on this machine, never sent.

**No secrets.** No API key or `.env` value appears in any output; this was checked mechanically.
