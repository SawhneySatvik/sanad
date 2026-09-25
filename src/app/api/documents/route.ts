import { documentView } from "@/server/http/views/document-view";
import { route } from "@/server/http/handler";
import * as understand from "@/server/services/understand";
import { AnalyzeDocumentInput, AnalyzeDocumentOutput } from "@/shared/contracts/documents";
import * as library from "@/server/services/library";
import { DocumentListOutput, ListQuery } from "@/shared/contracts/library";

export const GET = route({
  query: ListQuery, usesLlm: false, response: DocumentListOutput,
  run: ({ deps, principal, query }) => library.list(deps, principal, "document", query),
});

// Confirms the upload and analyses it. A failure after the document row exists answers with the
// error's status and the documentId to retry with (POST /api/documents/:id/analyze).
export const POST = route({
  body: AnalyzeDocumentInput,
  response: AnalyzeDocumentOutput,
  run: async ({ deps, principal, body }) => documentView(await understand.analyze(deps, principal, body)),
});
