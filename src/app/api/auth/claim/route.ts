import { route } from "@/server/http/handler";
import * as auth from "@/server/services/auth";
import { ClaimResultOutput } from "@/shared/contracts/claim";

// claim.user is the same authenticateUser answer that resolved `principal`; claim.guest is read
// from the request's signed cookie independently. clearsGuestSession: true answers a successful
// (200) claim with the cleared guest cookie instead of any minted one.
export const POST = route({
  claimSession: true,
  clearsGuestSession: true,
  usesLlm: false,
  response: ClaimResultOutput,
  run: ({ deps, claim }) => auth.claimGuestSession(deps, claim),
});
