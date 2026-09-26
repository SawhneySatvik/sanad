import { route } from "@/server/http/handler";
import * as documentText from "@/server/services/document-text";
import { IdParams } from "@/shared/contracts/common";
import { DocumentTextOutput } from "@/shared/contracts/document-text";

// usesLlm: false — a read of already-extracted text, never a model call.
export const GET = route({
  params: IdParams,
  usesLlm: false,
  response: DocumentTextOutput,
  run: ({ deps, principal, params }) => documentText.getText(deps, principal, params.id),
  // canonical_text is extracted once, server-side, and never changes afterward — the whole response
  // is a pure function of documentId, so its own stored hash doubles as the ETag. Only reached once
  // getText() has already passed its owner check.
  cache: (result) => ({ etag: `"${(result as { textHash: string }).textHash}"`, cacheControl: "private, max-age=0, must-revalidate" }),
});
