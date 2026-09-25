import { route } from "@/server/http/handler";
import { threadView } from "@/server/http/views/thread-view";
import * as askService from "@/server/services/ask";
import { CreateThreadInput, MAX_CREATE_THREAD_BODY_BYTES, ThreadOutput } from "@/shared/contracts/threads";
import * as library from "@/server/services/library";
import { ListQuery, ThreadListOutput } from "@/shared/contracts/library";

export const GET = route({
  query: ListQuery, usesLlm: false, response: ThreadListOutput,
  run: ({ deps, principal, query }) => library.list(deps, principal, "thread", query),
});

// User principal only: requireUser refuses a guest with the same VALIDATION_FAILED
// askService.createThread throws, before the up-to-16 MiB body is read.
// maxBodyBytes: route()'s 1 MiB default is smaller than the largest contract-valid import.
export const POST = route({
  body: CreateThreadInput,
  requireUser: true,
  response: ThreadOutput,
  maxBodyBytes: MAX_CREATE_THREAD_BODY_BYTES,
  usesLlm: false, // createThread never calls the LLM — DB-only, even when importing citations
  run: async ({ deps, principal, body }) => threadView(await askService.createThread(deps, principal, body)),
});
