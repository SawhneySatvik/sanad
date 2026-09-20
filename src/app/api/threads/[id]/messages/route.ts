import { route } from "@/server/http/handler";
import { askEventView, threadMessageView } from "@/server/http/views/message-view";
import * as askService from "@/server/services/ask";
import { IdParams } from "@/shared/contracts/common";
import { AskEventOutput, AskMessageInput, DEFAULT_LIST_MESSAGES_LIMIT, ListMessagesInput, MessagesOutput } from "@/shared/contracts/threads";

export const GET = route({
  params: IdParams,
  query: ListMessagesInput,
  response: MessagesOutput,
  usesLlm: false, // listRecentMessages re-verifies against stored canonical_text — no LLM call
  run: async ({ deps, principal, params, query }) => {
    const { messages, sources } = await askService.listRecentMessages(deps, principal, params.id, {
      limit: query.limit ?? DEFAULT_LIST_MESSAGES_LIMIT,
    });
    return { messages: messages.map((message) => threadMessageView(message, sources)) };
  },
});

// Streamed: the first event decides the HTTP status before any header is sent. signal: req.signal
// aborts this turn's in-flight LLM calls if the client disconnects, instead of letting them run to
// completion unobserved.
export const POST = route({
  params: IdParams,
  body: AskMessageInput,
  events: AskEventOutput,
  run: ({ deps, principal, params, body, signal }) =>
    askEventView(askService.ask(deps, principal, { threadId: params.id, query: body.query, signal })),
});
