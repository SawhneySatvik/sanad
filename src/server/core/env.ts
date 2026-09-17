/**
 * Reads process.env. Deliberately not a closed zod schema: other modules read env vars this file
 * doesn't enumerate, and a closed schema would block adding one elsewhere. Values are read lazily,
 * inside each function and never at module scope, so importing this module needs no env var set.
 */

/** Thrown by requireEnv when a required variable is unset or blank. */
export class ConfigError extends Error {
  readonly variableName: string;

  constructor(variableName: string) {
    // Names the missing variable, never its value — this module never reads process.env anywhere
    // but inside requireEnv/optionalEnv, so there's nothing but the name to leak in the first place.
    super(`Missing required environment variable: ${variableName}`);
    this.name = "ConfigError";
    this.variableName = variableName;
  }
}

/** Reads a required env var; throws ConfigError if it's unset or empty. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(name);
  }
  return value;
}

/** Reads an optional env var; returns undefined if it's unset or empty, never throws. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === "" ? undefined : value;
}

const SABOOT_E2E_VAR = "SABOOT_E2E";

// Mirrors src/db/client.ts's own isProduction(): Vercel sets VERCEL on every deployment, preview
// included, whatever NODE_ENV says. Reimplemented locally so env.ts has no dependency on db/client.
function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || optionalEnv("VERCEL") !== undefined;
}

/**
 * Whether the e2e harness's test-only affordances (the provider transport redirect, the
 * forced-throw route, the shortened guest TTL) are active. SABOOT_E2E=1 in production is refused
 * at the point anything reads it, not just by the e2e server script never setting it — a stray env
 * var must never unlock a redirect that points live provider traffic at a local fake, or a route
 * that exists only to throw.
 * @throws ConfigError if SABOOT_E2E=1 is set in production.
 */
export function isE2eMode(): boolean {
  const enabled = optionalEnv(SABOOT_E2E_VAR) === "1";
  if (enabled && isProductionEnv()) {
    const error = new ConfigError(SABOOT_E2E_VAR);
    error.message = `${SABOOT_E2E_VAR} must never be set in production — it redirects provider traffic to a local fake and shortens the guest TTL.`;
    throw error;
  }
  return enabled;
}
