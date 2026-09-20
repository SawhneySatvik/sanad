import { documentView } from "@/server/http/views/document-view";
import { route } from "@/server/http/handler";
import * as understand from "@/server/services/understand";
import { IdParams } from "@/shared/contracts/common";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";

export const GET = route({
  params: IdParams,
  // get() never reads deps.llm: a read needs no provider key.
  usesLlm: false,
  response: DocumentWithFindingsOutput,
  run: async ({ deps, principal, params }) => documentView(await understand.get(deps, principal, params.id)),
});
