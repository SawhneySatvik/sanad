import { prepareView } from "@/server/http/views/prepare-view";
import { route } from "@/server/http/handler";
import * as prepare from "@/server/services/prepare";
import { IdParams } from "@/shared/contracts/common";
import { PrepareOutput, PrepareQuery } from "@/shared/contracts/prepare";

// generate() reads findings only through understand's get() (fresh, re-verified) — never raw text,
// never a stored verification_status column.
export const POST = route({
  params: IdParams,
  query: PrepareQuery,
  response: PrepareOutput,
  run: async ({ deps, principal, params, query }) =>
    prepareView(await prepare.generate(deps, principal, params.id, query.lens)),
});
