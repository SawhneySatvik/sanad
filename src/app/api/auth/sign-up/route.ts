import { route } from "@/server/http/handler";
import * as auth from "@/server/services/auth";
import { SignUpInput } from "@/shared/contracts/auth";
import { SessionOutput } from "@/shared/contracts/session";

// userSession: "set-account" signs a fresh account-session cookie from run()'s userId once this
// succeeds; `principal` here is the caller's own guest (or, rarely, already-signed-in) identity,
// resolved exactly as every other route sees it — auth.signUp reuses it to claim guest data.
// clearsGuestSession: true drops the just-claimed guest cookie in the same response, as the claim
// route does — otherwise a later sign-out on a shared device would hand the old guest id back out.
export const POST = route({
  body: SignUpInput,
  usesLlm: false,
  userSession: "set-account",
  clearsGuestSession: true,
  response: SessionOutput,
  run: ({ deps, principal, body }) => auth.signUp(deps, principal, body),
});
