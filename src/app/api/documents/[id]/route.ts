import { documentView } from "@/server/http/views/document-view";
import { route } from "@/server/http/handler";
import * as understand from "@/server/services/understand";
import { IdParams } from "@/shared/contracts/common";
import { DocumentWithFindingsOutput } from "@/shared/contracts/documents";
import * as library from "@/server/services/library";
import { DocumentListRowOutput, RenameInput } from "@/shared/contracts/library";

export const PATCH = route({
  params: IdParams, body: RenameInput, usesLlm: false, response: DocumentListRowOutput,
  run: ({ deps, principal, params, body }) => library.rename(deps, principal, "document", params.id, body.title),
});

export const DELETE = route({
  params: IdParams, usesLlm: false, status: 204,
  run: ({ deps, principal, params }) => library.remove(deps, principal, "document", params.id),
});

export const GET = route({
  params: IdParams,
  // get() never reads deps.llm: a read needs no provider key.
  usesLlm: false,
  response: DocumentWithFindingsOutput,
  run: async ({ deps, principal, params }) => documentView(await understand.get(deps, principal, params.id)),
});
