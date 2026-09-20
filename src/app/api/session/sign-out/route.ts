import { route } from "@/server/http/handler";
import * as session from "@/server/services/session";
import { SessionOutput } from "@/shared/contracts/session";

// userSession: "clear" drops the dev user-session cookie once this succeeds; a fresh guest session
// is minted lazily on the next principal-resolving request, not here.
export const POST = route({
  usesLlm: false,
  userSession: "clear",
  response: SessionOutput,
  run: () => session.signOut(),
});
