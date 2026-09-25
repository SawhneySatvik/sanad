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
});
