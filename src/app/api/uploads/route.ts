import { route } from "@/server/http/handler";
import { withRelayUrl } from "@/server/http/uploads";
import { CreateUploadTargetInput, UploadTargetOutput } from "@/shared/contracts/uploads";

export const POST = route({
  body: CreateUploadTargetInput,
  usesLlm: false,
  response: UploadTargetOutput,
  run: async ({ deps, principal, body }) => withRelayUrl(await deps.storage.createUploadTarget(principal, body)),
});
