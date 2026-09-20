import { getContainer } from "@/server/container";
import type { HealthOutput } from "@/shared/contracts/health";

// Asks the container to build the providers and storage adapter, so their own validation answers —
// "ok" never sits next to an upload or analysis that would fail on configuration. No provider call.
/** Whether the configured LLM providers and storage adapter can currently be built. */
export function checkHealth(): HealthOutput {
  const config = getContainer().configStatus();
  return { status: config.llm && config.storage ? "ok" : "degraded", config };
}
