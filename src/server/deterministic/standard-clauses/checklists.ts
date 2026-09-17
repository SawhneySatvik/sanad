import type { DocumentTypeId } from "../document-type-registry";
import { FREELANCE_SERVICE_AGREEMENT_ITEMS } from "./freelance-service-agreement";
import { JOB_OFFER_LETTER_ITEMS } from "./job-offer-letter";
import { LEAVE_AND_LICENSE_ITEMS } from "./leave-and-license";
import { NDA_ITEMS } from "./nda";
import { PRIVACY_POLICY_ITEMS } from "./privacy-policy";
import type { StandardClauseItem } from "./types";

/** Stored with every gap. Bump on any change to an item or its phrases: the same text can then yield different gaps. */
export const STANDARD_CLAUSES_VERSION = "1.0.0";

/**
 * The checklist for each document type. generic and grounded_response have none: without a known
 * document type no clause is "expected", so any absence claim would be a guess.
 */
export const STANDARD_CLAUSES_BY_DOCUMENT_TYPE: Record<DocumentTypeId, readonly StandardClauseItem[]> = {
  leave_and_license: LEAVE_AND_LICENSE_ITEMS,
  job_offer_letter: JOB_OFFER_LETTER_ITEMS,
  nda: NDA_ITEMS,
  privacy_policy: PRIVACY_POLICY_ITEMS,
  freelance_service_agreement: FREELANCE_SERVICE_AGREEMENT_ITEMS,
  grounded_response: [],
  generic: [],
};
