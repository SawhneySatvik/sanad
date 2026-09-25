import { draftView } from "@/server/http/views/draft-view";
import { route } from "@/server/http/handler";
import * as library from "@/server/services/library";
import { DraftListOutput, ListQuery } from "@/shared/contracts/library";

export const GET = route({
  query: ListQuery, usesLlm: false, response: DraftListOutput,
  run: ({ deps, principal, query }) => library.list(deps, principal, "draft", query),
});
import * as draft from "@/server/services/draft";
import { CreateDraftInput, DraftOutput } from "@/shared/contracts/drafts";

// create() checks canAccess on groundingDocumentId (document_grounded mode) before any LLM call —
// another principal's document there is the same 404 a missing one gets.
export const POST = route({
  body: CreateDraftInput,
  response: DraftOutput,
  run: async ({ deps, principal, body }) => draftView(await draft.create(deps, principal, body)),
});
