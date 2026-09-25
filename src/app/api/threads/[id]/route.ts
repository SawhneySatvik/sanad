import { route } from "@/server/http/handler";
import * as library from "@/server/services/library";
import { IdParams } from "@/shared/contracts/common";
import { RenameInput, ThreadListRowOutput } from "@/shared/contracts/library";

export const PATCH = route({
  params: IdParams, body: RenameInput, usesLlm: false, response: ThreadListRowOutput,
  run: ({ deps, principal, params, body }) => library.rename(deps, principal, "thread", params.id, body.title),
});

export const DELETE = route({
  params: IdParams, usesLlm: false, status: 204,
  run: ({ deps, principal, params }) => library.remove(deps, principal, "thread", params.id),
});
