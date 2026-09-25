import { route } from "@/server/http/handler";
import * as library from "@/server/services/library";
import { DeleteAllOutput } from "@/shared/contracts/library";

export const DELETE = route({
  usesLlm: false, clearsGuestSession: true, response: DeleteAllOutput,
  run: ({ deps, principal }) => library.deleteAll(deps, principal),
});
