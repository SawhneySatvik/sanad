import { route } from "@/server/http/handler";
import { checkHealth } from "@/server/http/health";
import { HealthOutput } from "@/shared/contracts/health";

// No caller identity: a probe mints no guest session and writes no IP-tier row.
export const GET = route({
  principal: "none",
  response: HealthOutput,
  run: async () => checkHealth(),
});
