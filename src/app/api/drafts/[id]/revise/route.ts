import { draftView } from "@/server/http/views/draft-view";
import { route } from "@/server/http/handler";
import * as draft from "@/server/services/draft";
import { IdParams } from "@/shared/contracts/common";
import { DraftOutput, ReviseDraftInput } from "@/shared/contracts/drafts";

// revise() authorizes the parent draft via canAccess (404 for foreign/missing/malformed) before
// making its own fresh LLM call.
export const POST = route({
  params: IdParams,
  body: ReviseDraftInput,
  response: DraftOutput,
  run: async ({ deps, principal, params, body }) => draftView(await draft.revise(deps, principal, params.id, body)),
});
