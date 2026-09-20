import { draftView } from "@/server/http/views/draft-view";
import { route } from "@/server/http/handler";
import * as draft from "@/server/services/draft";
import { IdParams } from "@/shared/contracts/common";
import { DraftWithSectionsOutput } from "@/shared/contracts/drafts";

// get() never reads deps.llm (no model call on a read) — this route works even with no LLM keys
// configured.
export const GET = route({
  params: IdParams,
  response: DraftWithSectionsOutput,
  usesLlm: false,
  run: async ({ deps, principal, params }) => draftView(await draft.get(deps, principal, params.id)),
});
