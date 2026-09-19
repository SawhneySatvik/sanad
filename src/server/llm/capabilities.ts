/**
 * Shared capability enforcement — every adapter that doesn't support `nativeDocumentInput` rejects a
 * `nativeFile` document the same way, with the same error code, regardless of which adapter it is.
 */

import { AppError } from "@/server/core/errors";
import type { LlmCapabilities, LlmDocumentInput } from "./types";

/** Throws unless every native-file document in `documents` is allowed by `capabilities`. */
export function assertDocumentsWithinCapabilities(
  capabilities: Pick<LlmCapabilities, "nativeDocumentInput">,
  documents: LlmDocumentInput[] | undefined,
): void {
  if (capabilities.nativeDocumentInput) return;
  if (documents?.some((doc) => doc.nativeFile)) {
    throw new AppError("VALIDATION_FAILED", "This model does not support native document input.");
  }
}
