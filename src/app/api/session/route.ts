import { route } from "@/server/http/handler";
import * as session from "@/server/services/session";
import { SessionOutput } from "@/shared/contracts/session";

export const GET = route({
  usesLlm: false,
  response: SessionOutput,
  run: ({ deps, principal }) => session.getSession(deps, principal),
});
