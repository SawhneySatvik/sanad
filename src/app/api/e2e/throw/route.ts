import { route } from "@/server/http/handler";
import * as e2e from "@/server/services/e2e";
import { HealthOutput } from "@/shared/contracts/health";

// SABOOT_E2E=1 only: a deliberate failure for the error-boundary gates. 404s outside the e2e
// harness (forceThrow's own guard, never reached at all in production — isE2eMode() itself refuses
// SABOOT_E2E=1 there). `response` is never actually serialized: forceThrow() always throws, so any
// contract type satisfies the route() signature.
export const GET = route({
  usesLlm: false,
  response: HealthOutput,
  run: async () => e2e.forceThrow(),
});
