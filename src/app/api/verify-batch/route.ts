import { route } from "@/server/http/handler";
import { verifyBatchView } from "@/server/http/views/verify-batch-view";
import * as verifyBatch from "@/server/services/verify-batch";
import { VerifyBatchInput, VerifyBatchOutput } from "@/shared/contracts/verify-batch";

export const POST = route({
  body: VerifyBatchInput,
  usesLlm: false,
  response: VerifyBatchOutput,
  run: async ({ deps, principal, body }) => verifyBatchView(await verifyBatch.run(deps, principal, body)),
});
