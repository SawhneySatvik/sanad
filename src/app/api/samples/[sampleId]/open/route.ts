import { route } from "@/server/http/handler";
import * as samples from "@/server/services/samples";
import { SampleIdParams, SampleOpenOutput } from "@/shared/contracts/samples";

// No model call on this path (a fixed recording replays instead), so it never touches the
// rate-limited LLM client — see src/server/samples/open.ts for where the replay's own client comes from.
export const POST = route({
  params: SampleIdParams,
  usesLlm: false,
  response: SampleOpenOutput,
  run: ({ deps, principal, params }) => samples.openSample(deps, principal, params.sampleId),
});
