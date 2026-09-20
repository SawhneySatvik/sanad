import { route } from "@/server/http/handler";
import * as session from "@/server/services/session";
import { DevSignInInput, SessionOutput } from "@/shared/contracts/session";

// userSession: "set" signs a fresh user-session cookie from run()'s userId once this succeeds; the
// dev adapter itself refuses in production (session.devSignIn throws NOT_FOUND there, so the route
// 404s instead of signing anything).
export const POST = route({
  body: DevSignInInput,
  usesLlm: false,
  userSession: "set",
  response: SessionOutput,
  run: ({ deps, body }) => session.devSignIn(deps, body),
});
