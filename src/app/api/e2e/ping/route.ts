import { route } from "@/server/http/handler";
import * as e2e from "@/server/services/e2e";
import { HealthOutput } from "@/shared/contracts/health";

// SABOOT_E2E=1 only: playwright.config.ts's webServer.url points here specifically (not
// /api/health, which answers 200 for an ordinary non-e2e server too) so reuseExistingServer can
// never attach to a server that isn't actually the e2e harness. 404s outside the harness
// (ping()'s own isE2eMode() guard) — refused in production the same way /api/e2e/throw is.
export const GET = route({
  usesLlm: false,
  response: HealthOutput,
  run: async () => e2e.ping(),
});
