import { documentView } from "@/server/http/views/document-view";
import { route } from "@/server/http/handler";
import * as understand from "@/server/services/understand";
import { AnalyzeDocumentInput, AnalyzeDocumentOutput } from "@/shared/contracts/documents";

// Confirms the upload and analyses it. A failure after the document row exists answers with the
// error's status and the documentId to retry with (POST /api/documents/:id/analyze).
export const POST = route({
  body: AnalyzeDocumentInput,
  response: AnalyzeDocumentOutput,
  run: async ({ deps, principal, body }) => documentView(await understand.analyze(deps, principal, body)),
});
