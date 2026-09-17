/**
 * The guest data TTL every guest-owned row (documents, comparisons, drafts) should expire after.
 * Overridable only inside the e2e harness, via SABOOT_E2E_GUEST_TTL_SECONDS, so a Playwright spec
 * can observe real expiry without waiting hours. Wiring documents.ts/drafts.ts/comparisons.ts's own
 * TTL constants to this function is a data-layer change; this file only exports the seam they call.
 */

import { isE2eMode, optionalEnv } from "./env";

/** Guest data lives 2-4 hours; this is the midpoint, matching auth/session.ts's own guest-cookie TTL. */
export const DEFAULT_GUEST_DATA_TTL_SECONDS = 3 * 60 * 60;

const OVERRIDE_VAR = "SABOOT_E2E_GUEST_TTL_SECONDS";
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

let warnedInvalidOverride = false;

/**
 * The TTL (seconds) guest-owned rows should be created with. Outside the e2e harness — including
 * whenever isE2eMode() itself would refuse (production) — this is always DEFAULT_GUEST_DATA_TTL_SECONDS;
 * the override only ever takes effect when SABOOT_E2E=1 outside production.
 */
export function guestDataTtlSeconds(): number {
  if (!isE2eMode()) return DEFAULT_GUEST_DATA_TTL_SECONDS;

  const raw = optionalEnv(OVERRIDE_VAR);
  if (raw === undefined) return DEFAULT_GUEST_DATA_TTL_SECONDS;

  const trimmed = raw.trim();
  if (!POSITIVE_INTEGER_RE.test(trimmed)) {
    if (!warnedInvalidOverride) {
      warnedInvalidOverride = true;
      // A TTL-seconds-shaped value, never a secret — safe to name in a warning.
      console.warn(`${OVERRIDE_VAR} is not a positive integer (got ${JSON.stringify(raw)}) — using the default guest TTL.`);
    }
    return DEFAULT_GUEST_DATA_TTL_SECONDS;
  }
  return Number(trimmed);
}
