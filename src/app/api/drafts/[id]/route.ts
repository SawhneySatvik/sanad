import { draftView } from "@/server/http/views/draft-view";
import { route } from "@/server/http/handler";
import * as draft from "@/server/services/draft";
import { IdParams } from "@/shared/contracts/common";
import { DraftWithSectionsOutput } from "@/shared/contracts/drafts";
import * as library from "@/server/services/library";
import { DraftListRowOutput, RenameInput } from "@/shared/contracts/library";

export const PATCH = route({
  params: IdParams, body: RenameInput, usesLlm: false, response: DraftListRowOutput,
  run: ({ deps, principal, params, body }) => library.rename(deps, principal, "draft", params.id, body.title),
});

export const DELETE = route({
  params: IdParams, usesLlm: false, status: 204,
  run: ({ deps, principal, params }) => library.remove(deps, principal, "draft", params.id),
});

// get() never reads deps.llm (no model call on a read) — this route works even with no LLM keys
// configured.
export const GET = route({
  params: IdParams,
  response: DraftWithSectionsOutput,
  usesLlm: false,
  run: async ({ deps, principal, params }) => draftView(await draft.get(deps, principal, params.id)),
});
