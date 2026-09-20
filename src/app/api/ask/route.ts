import { route } from "@/server/http/handler";
import { askEventView } from "@/server/http/views/message-view";
import * as askService from "@/server/services/ask";
import { AskEventOutput, AskGuestInput } from "@/shared/contracts/threads";

// The unsaved-turn Ask endpoint: no threadId, ever — the caller's own client-held history and
// attached documentIds ground each call. signal: req.signal aborts this turn's in-flight LLM calls
// if the client disconnects, instead of letting them run to completion unobserved.
export const POST = route({
  body: AskGuestInput,
  events: AskEventOutput,
  run: ({ deps, principal, body, signal }) => askEventView(askService.ask(deps, principal, { ...body, signal })),
});
