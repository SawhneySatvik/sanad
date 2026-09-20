import { documentView } from "@/server/http/views/document-view";
import { route } from "@/server/http/handler";
import * as understand from "@/server/services/understand";
import { IdParams } from "@/shared/contracts/common";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";

// The idempotent retry: resumes whichever stage is incomplete, or returns the existing analysis
// without a model call.
export const POST = route({
  params: IdParams,
  response: DocumentWithFindingsOutput,
  run: async ({ deps, principal, params }) => documentView(await understand.analyzeDocument(deps, principal, params.id)),
});
