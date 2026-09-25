/**
 * The samples registry: five bundled, pre-analysed Understand documents a visitor can open without
 * a live model call. Every entry pins the exact text its recording answers and the exact
 * prompt/schema shape it was captured against, so a stale bundle, a divergent live prompt, or an
 * edited recording refuses to replay rather than silently drifting from what was actually recorded.
 * A Compare pair (lease_v2) has no live-validated capture and is deliberately absent from
 * SAMPLE_IDS.
 */

import { createHash } from "node:crypto";
import { detectDocumentType } from "@/server/deterministic/detect-type";
import { extractDocument } from "@/server/deterministic/extract";
import type { DocumentTypeId } from "@/server/deterministic/document-type-registry";
import { notFound } from "@/server/core/errors";
import {
  buildUnderstandResponseSchema,
  buildUnderstandSystemPrompt,
  buildUnderstandUserPrompt,
  PROMPT_FINGERPRINT as LIVE_PROMPT_FINGERPRINT,
  PROMPT_VERSION as LIVE_PROMPT_VERSION,
} from "@/server/prompts/understand/analyze";
import { TEXT as LEASE_TEXT } from "./files/lease";
import { TEXT as OFFER_LETTER_TEXT } from "./files/offer_letter";
import { TEXT as NDA_TEXT } from "./files/nda";
import { TEXT as PRIVACY_POLICY_TEXT } from "./files/privacy_policy";
import { TEXT as FREELANCE_TEXT } from "./files/freelance";
import leaseRecording from "./recorded/lease.json";
import offerLetterRecording from "./recorded/offer_letter.json";
import ndaRecording from "./recorded/nda.json";
import privacyPolicyRecording from "./recorded/privacy_policy.json";
import freelanceRecording from "./recorded/freelance.json";

/** Every Understand sample the registry ships. Order is display order: lease shows first for a tenant. */
export const SAMPLE_IDS = ["lease", "offer_letter", "nda", "privacy_policy", "freelance"] as const;
/** One of {@link SAMPLE_IDS}. */
export type SampleId = (typeof SAMPLE_IDS)[number];

/** The shape recorded/*.json round-trips through: UnderstandModelOutput's findings, plus the model that answered. */
export interface RecordedUnderstandOutput {
  modelUsed: string;
  findings: { category: string; quote: string | null; lensExplanations: Record<string, string> }[];
}

/**
 * One sample: its bundled text, recorded analysis, and every pin the open flow checks before
 * replaying it. Nothing here is client input — the whole object is fixed application code and data.
 */
export interface SampleEntry {
  sampleId: SampleId;
  documentType: DocumentTypeId;
  text: string;
  filename: string;
  mimeType: string;
  title: string;
  /** extractDocument(bytes).canonicalTextHash must equal this — see assertSampleIsLive. */
  canonicalTextHash: string;
  recording: RecordedUnderstandOutput;
  modelUsed: string;
  /**
   * This exact document's system+user prompt, sha256'd at reshape time. RecordedLlmClient refuses
   * to answer a call whose live-built prompt hashes to anything else — including a prompt built for
   * the wrong document, or one built after the prompt template itself changed.
   */
  inputFingerprint: string;
  /**
   * sha256 of the recording's own JSON (stable key order, as authored), pinned at reshape time —
   * catches a recorded/*.json hand-edited afterward (say, to smuggle a status field) without also
   * updating this pin.
   */
  recordingHash: string;
}

// Pinned literal copies of what analyze.ts exported when these recordings were captured — never the
// live import. Comparing a pinned literal against the live constant (see promptHasDiverged below) is
// what actually detects drift; comparing the live value against itself would trivially always pass.
const PINNED_PROMPT_VERSION = "understand-v3";
const PINNED_PROMPT_FINGERPRINT = "77023a2fc6f417958e0b60a914f41962e4fd5d619096b968d8942983612c94e5";

const ENTRIES: Record<SampleId, SampleEntry> = {
  lease: {
    sampleId: "lease",
    documentType: "leave_and_license",
    text: LEASE_TEXT,
    filename: "leave-and-license-sample.txt",
    mimeType: "text/plain",
    title: "Sample: Leave and License Agreement",
    canonicalTextHash: "ff6ce0563a9135dd5fe24dcb663bae4bfbc41aaac7bdab7541a97ce501c86245",
    recording: leaseRecording,
    modelUsed: "gemini-2.5-flash",
    inputFingerprint: "32f7da2af6fe1ad0d91c4e2db0eca6b617b03ed807ef0d03a3d58f9b46907a5a",
    recordingHash: "9c9047df13a57db8ab4185ba3a8067339698e9ef67bd6af60e4acccda88dbf61",
  },
  offer_letter: {
    sampleId: "offer_letter",
    documentType: "job_offer_letter",
    text: OFFER_LETTER_TEXT,
    filename: "job-offer-letter-sample.txt",
    mimeType: "text/plain",
    title: "Sample: Job Offer Letter",
    canonicalTextHash: "b7c17a2bd86de32101f1a705bcccd3c3779a69a82e6d0b370e8c088968f2f89a",
    recording: offerLetterRecording,
    modelUsed: "gemini-2.5-flash",
    inputFingerprint: "91f6362226a3573667a662a13f66cc2613821bf03bbc2e75c6079643915ff9c7",
    recordingHash: "a53b92977708e4872f7b974bf5efab31fb056bbaa4a5cc37c6ab2c65f104030c",
  },
  nda: {
    sampleId: "nda",
    documentType: "nda",
    text: NDA_TEXT,
    filename: "nda-sample.txt",
    mimeType: "text/plain",
    title: "Sample: Non-Disclosure Agreement",
    canonicalTextHash: "364b34c036f86ee8d8cd1548304a8d6a53e9f517818dbdd5fe8fe79110e39a26",
    recording: ndaRecording,
    modelUsed: "gemini-2.5-flash",
    inputFingerprint: "6437bbf491bcde911610f5243ce7ce2353b98b8f9f869da9a385ccd21b910578",
    recordingHash: "e7ed44314322686525a1cd33bf03c5103d08e1a2234637e746b44376c38ad458",
  },
  privacy_policy: {
    sampleId: "privacy_policy",
    documentType: "privacy_policy",
    text: PRIVACY_POLICY_TEXT,
    filename: "privacy-policy-sample.txt",
    mimeType: "text/plain",
    title: "Sample: Privacy Policy",
    canonicalTextHash: "1e0bfebabfda93485e46c41fca4a0d383cc842c16c406a032723df72b9590878",
    recording: privacyPolicyRecording,
    modelUsed: "gemini-2.5-flash",
    inputFingerprint: "4250908330a94f84f311388926143396f6354c6cfa2c2a445427feea8091988d",
    recordingHash: "b6004a5adf8883715f90b9f173ace2cf7cecf6ed1a9d4b148953d1f24c6dae2b",
  },
  freelance: {
    sampleId: "freelance",
    documentType: "freelance_service_agreement",
    text: FREELANCE_TEXT,
    filename: "freelance-agreement-sample.txt",
    mimeType: "text/plain",
    title: "Sample: Freelance Service Agreement",
    canonicalTextHash: "566e4bccf9322eeafc52fec75081d21a374792cc5df739fb1a6454d69259b029",
    recording: freelanceRecording,
    modelUsed: "gemini-2.5-flash",
    inputFingerprint: "07826f990169c931186a9f4b844f2777771567e7b8b87fe77241c5a912c97cb0",
    recordingHash: "4244da7f93079b5f9aadbb28fb16a91c6e9a1a0fc2a6b263adadc0cb25ddc394",
  },
};

function isSampleId(value: string): value is SampleId {
  return (SAMPLE_IDS as readonly string[]).includes(value);
}

/** Whether the live prompt/schema shape has moved on from what every entry here was captured against. */
export function promptHasDiverged(): boolean {
  return PINNED_PROMPT_VERSION !== LIVE_PROMPT_VERSION || PINNED_PROMPT_FINGERPRINT !== LIVE_PROMPT_FINGERPRINT;
}

/**
 * The literal pin every entry here was captured against — exported only so registry.test.ts can
 * compare it to the live PROMPT_VERSION/PROMPT_FINGERPRINT itself (the CI divergence gate). Nothing
 * in the open flow needs this: getSampleEntry()/promptHasDiverged() already do the comparison.
 */
export function pinnedPromptSignature(): { promptVersion: string; promptFingerprint: string } {
  return { promptVersion: PINNED_PROMPT_VERSION, promptFingerprint: PINNED_PROMPT_FINGERPRINT };
}

/**
 * Looks up a sample by id — never text, a file or a model output, so this can never become an
 * analysis cache or an oracle. Returns null for an unknown id, an id with no shipped entry, or
 * (defense in depth beyond the CI pin comparison in this module's own test) a live prompt that has
 * moved on from what every recording here answers; the route maps null to 404, indistinguishable
 * from an unknown id — a distinguishable status would tell a caller which case applied.
 */
export function getSampleEntry(sampleId: string): SampleEntry | null {
  if (!isSampleId(sampleId)) return null;
  if (promptHasDiverged()) return null;
  return ENTRIES[sampleId];
}

/** Every entry, for the registry's own tests — never for the open route (use getSampleEntry). */
export function allSampleEntries(): SampleEntry[] {
  return SAMPLE_IDS.map((id) => ENTRIES[id]);
}

/** The bundled text as bytes, exactly as a real upload's file bytes would arrive at extractDocument. */
export function sampleBytes(entry: Pick<SampleEntry, "text">): Buffer {
  return Buffer.from(entry.text, "utf8");
}

/** sha256 of a recording's JSON, in the exact key order it round-trips as — what recordingHash pins. */
export function hashRecording(recording: RecordedUnderstandOutput): string {
  return createHash("sha256").update(JSON.stringify(recording), "utf8").digest("hex");
}

/** Everything a replay depends on, freshly derived — never read from the entry's own pinned fields. */
export interface SamplePins {
  canonicalTextHash: string;
  documentType: DocumentTypeId;
  inputFingerprint: string;
  recordingHash: string;
  inputMode: "text";
  schemaParses: boolean;
  modelUsed: string;
}

/**
 * Rebuilds every value assertSampleIsLive checks, from the bundled bytes and the live
 * extraction/detection/prompt-building code — the exact same steps a replay itself runs — plus the
 * recording's own hash and its parse against the live response schema. Returns null for bytes that
 * no longer extract to plain text (a bundled sample is never a scan).
 */
export async function recomputeSamplePins(
  entry: Pick<SampleEntry, "text" | "mimeType" | "recording">,
): Promise<SamplePins | null> {
  const extracted = await extractDocument({ bytes: sampleBytes(entry), mimeType: entry.mimeType });
  if (extracted.kind !== "extracted") return null;
  const detection = detectDocumentType(extracted.canonicalText);
  const systemPrompt = buildUnderstandSystemPrompt(detection.documentType);
  const userPrompt = buildUnderstandUserPrompt({
    canonicalText: extracted.canonicalText,
    canonicalTextHash: extracted.canonicalTextHash,
  });
  return {
    canonicalTextHash: extracted.canonicalTextHash,
    documentType: detection.documentType,
    inputFingerprint: createHash("sha256").update(systemPrompt + userPrompt, "utf8").digest("hex"),
    recordingHash: hashRecording(entry.recording),
    inputMode: "text",
    schemaParses: buildUnderstandResponseSchema(detection.documentType).safeParse(entry.recording).success,
    modelUsed: entry.recording.modelUsed,
  };
}

/** What a fresh recomputation must equal for `entry` to still be safe to replay. */
export function pinsOf(entry: SampleEntry): SamplePins {
  return {
    canonicalTextHash: entry.canonicalTextHash,
    documentType: entry.documentType,
    inputFingerprint: entry.inputFingerprint,
    recordingHash: entry.recordingHash,
    inputMode: "text",
    schemaParses: true,
    modelUsed: entry.modelUsed,
  };
}

/**
 * Before replaying: recomputes everything a replay depends on and refuses unless it still matches
 * what's pinned — the bundled text's hash, the detected document type, this exact document's prompt
 * fingerprint, the recording's own hash, its parse against the live response schema, and the model
 * name. Called before any document row is created or any byte written, so a drift (a bundle edited
 * without updating its pins, a live prompt/detection change, a hand-edited recording) refuses
 * cleanly rather than creating a row for a reply nothing can now vouch for.
 * @throws AppError NOT_FOUND on any mismatch.
 */
export async function assertSampleIsLive(entry: SampleEntry): Promise<void> {
  const live = await recomputeSamplePins(entry);
  if (live === null) throw notFound();
  const pinned = pinsOf(entry);
  if (
    live.canonicalTextHash !== pinned.canonicalTextHash ||
    live.documentType !== pinned.documentType ||
    live.inputFingerprint !== pinned.inputFingerprint ||
    live.recordingHash !== pinned.recordingHash ||
    !live.schemaParses ||
    live.modelUsed !== pinned.modelUsed
  ) {
    throw notFound();
  }
}
