/**
 * Backs the e2e harness's two dev-only routes: the forced-throw route (src/app/api/e2e/throw) and
 * the ping route (src/app/api/e2e/ping, Playwright's own webServer.url — see playwright.config.ts).
 * A route file may make exactly one service-layer call (tests/architecture/route-conventions.ts),
 * so these functions exist to keep both routes thin adapters rather than branching inline.
 */

import { isE2eMode } from "@/server/core/env";
import { notFound } from "@/server/core/errors";
import type { HealthOutput } from "@/shared/contracts/health";

/**
 * Thrown, never returned: a real exception, not a 200 with an error body, is what an error boundary
 * needs to catch.
 * @throws AppError NOT_FOUND when the e2e harness isn't active; otherwise a plain Error, always.
 */
export async function forceThrow(): Promise<never> {
  if (!isE2eMode()) throw notFound();
  throw new Error("SABOOT_E2E forced-throw route: a deliberate failure for the error-boundary gates.");
}

/**
 * 200 only inside the e2e harness, 404 otherwise — so playwright.config.ts's webServer.url can
 * never mistake an ordinary (non-e2e) server for a ready e2e one, and reuse it. The body borrows
 * HealthOutput's shape (this route isn't itself a config-health check) rather than adding a new
 * contract type for one dev-only field.
 * @throws AppError NOT_FOUND when the e2e harness isn't active.
 */
export async function ping(): Promise<HealthOutput> {
  if (!isE2eMode()) throw notFound();
  return { status: "ok", config: { llm: true, storage: true } };
}
