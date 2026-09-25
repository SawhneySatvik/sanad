/**
 * Composition root: the one place real adapters are wired together. Route handlers never build a
 * dependency themselves — the route layer asks this module for the request's service deps. Storage
 * and provider clients are built lazily, on first use; a route declared `usesLlm: false` never
 * builds the providers, so it works without LLM keys. The per-call principal and client-IP rate-limit
 * tiers are charged only through the returned `llm` client, or its chargeLlmCall for a result served
 * in place of a call — never separately in a route.
 */

import { getDb, type Db } from "@/db/client";
import { ConfigError, optionalEnv, requireEnv } from "@/server/core/env";
import type { Principal } from "@/server/core/types";
import { canAccess } from "@/server/data/access";
import type { AuthenticateUser } from "@/server/http/principal";
import { tiersOf } from "@/server/llm/fallback";
import { GeminiLlmClient } from "@/server/llm/gemini";
import { createGeminiClient, createGemmaClient, geminiModelId } from "@/server/llm/providers";
import type { LlmClient } from "@/server/llm/types";
import { UNKNOWN_CLIENT_IP } from "@/server/rate-limit/client-ip";
import type { Clock } from "@/server/rate-limit/limiter";
import { createRateLimitedLlmClient } from "@/server/rate-limit/rate-limited-llm-client";
import { chargeCallerLimits, type WithCallerLimitOptions } from "@/server/rate-limit/with-caller-limit";
import { assertCacheModelId } from "@/server/services/understand";
import { LocalFsStorageAdapter } from "@/server/storage/local-fs-adapter";
import { PostgresStorageAdapter } from "@/server/storage/postgres-adapter";
import type { StorageAdapter } from "@/server/storage/types";

/** Everything one service call needs: db handle, storage adapter, rate-limited LLM client, and the cache-keying model id. */
export interface ServiceDeps {
  db: Db;
  storage: StorageAdapter;
  llm: LlmClient;
  modelId: string;
  // Charges one LLM call to the same caller tiers, limits and clock as `llm`, without making one —
  // for a result served in place of a model call, which must cost exactly what the call would.
  chargeLlmCall(): Promise<void>;
}

/** The primary and secondary LLM clients a container wires up. */
export interface LlmProviders {
  primary: LlmClient;
  secondary: LlmClient;
}

/** Rate-limit overrides; unset means the env var or limiter.ts's default. */
export interface RateLimitOverrides {
  // Inbound requests, on every route.
  ipPerMinute?: number;
  // LLM calls, charged per call.
  principalPerMinute?: number;
  ipLlmPerMinute?: number;
  principalPerDay?: number;
  ipLlmPerDay?: number;
  primaryPerMinute?: number;
  secondaryPerMinute?: number;
  clock?: Clock;
}

/** How a container's leaves are built; production and tests each supply their own. */
export interface ContainerOptions {
  db: Db;
  // Thunks so the production container can defer env reads to first use; each runs at most once successfully.
  storage: () => StorageAdapter;
  llm: () => LlmProviders;
  // The same secret the local storage adapter is built with, for the upload relay's URLs.
  localStorageSigningSecret: () => string;
  // The primary client's model id — understand's result cache is keyed on it. Checked against a real
  // Gemini primary when the providers are first built.
  primaryModelId: string;
  authenticateUser?: AuthenticateUser;
  rateLimits?: RateLimitOverrides;
}

/** Whether the providers and storage adapter can be built, by building them. */
export interface ConfigStatus {
  llm: boolean;
  storage: boolean;
}

/** The wired-up app: request-scoped dep resolution plus config health, over one db/adapters/providers set. */
export interface Container {
  readonly db: Db;
  readonly authenticateUser: AuthenticateUser;
  readonly rateLimits: RateLimitOverrides;
  localStorageSigningSecret(): string;
  // `clientIp` defaults to UNKNOWN_CLIENT_IP, the one shared bucket: a caller that doesn't pass the
  // request's IP gets the conservative limit, never an unlimited one.
  forRequest(principal: Principal, usesLlm?: boolean, clientIp?: string): ServiceDeps;
  // Whether the providers and the storage adapter can be built — by building them, so their own
  // validation (required keys, the ≥32-byte signing secret) is what answers.
  configStatus(): ConfigStatus;
}

// No auth adapter configured locally: nobody is a user in local dev.
const noUser: AuthenticateUser = async () => null;

function once<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

function builds(thunk: () => unknown): boolean {
  try {
    thunk();
    return true;
  } catch {
    return false;
  }
}

/** Builds a Container from `options`. The production entry point is getContainer(); tests build their own directly. */
export function createContainer(options: ContainerOptions): Container {
  const { db, primaryModelId } = options;
  // Understand keys its result cache on this id; a blank one would key every entry on "" and the
  // cache would never match the model that answered.
  if (primaryModelId.trim() === "") throw new Error("Container primaryModelId must not be blank.");
  const rateLimits = options.rateLimits ?? {};
  const storage = once(options.storage);
  const providers = once(() => {
    const built = options.llm();
    // A mismatch would make every cache read miss, silently. A test's fake primary reports no model id to check.
    const primary = tiersOf(built.primary)[0].client;
    if (primary instanceof GeminiLlmClient) assertCacheModelId({ modelId: primaryModelId }, primary.model);
    return built;
  });
  const localStorageSigningSecret = once(options.localStorageSigningSecret);

  return {
    db,
    authenticateUser: options.authenticateUser ?? noUser,
    rateLimits,
    localStorageSigningSecret,
    forRequest(principal, usesLlm = true, clientIp = UNKNOWN_CLIENT_IP) {
      const caller: WithCallerLimitOptions = {
        db,
        principal,
        clientIp,
        limits: {
          principalPerMinute: rateLimits.principalPerMinute,
          ipPerMinute: rateLimits.ipLlmPerMinute,
          principalPerDay: rateLimits.principalPerDay,
          ipPerDay: rateLimits.ipLlmPerDay,
        },
        clock: rateLimits.clock,
      };
      // One client per request. Its principal and IP tiers are charged per LLM call, so building it
      // charges nothing; building it here surfaces a missing provider key as a ConfigError before
      // the service runs, never half way through.
      const llm = usesLlm
        ? createRateLimitedLlmClient({
            db,
            ...providers(),
            primaryProvider: "gemini",
            secondaryProvider: "gemma",
            principal,
            clientIp,
            principalLimit: caller.limits?.principalPerMinute,
            ipLlmLimit: caller.limits?.ipPerMinute,
            principalDailyLimit: caller.limits?.principalPerDay,
            ipLlmDailyLimit: caller.limits?.ipPerDay,
            primaryLimit: rateLimits.primaryPerMinute,
            secondaryLimit: rateLimits.secondaryPerMinute,
            clock: rateLimits.clock,
          })
        : undefined;
      return {
        db,
        get storage() {
          return storage();
        },
        get llm() {
          if (!llm) throw new Error("This route is declared usesLlm: false, but its service used the LLM.");
          return llm;
        },
        modelId: primaryModelId,
        chargeLlmCall: () => chargeCallerLimits(caller),
      };
    },
    configStatus: () => ({
      llm: builds(providers),
      storage: builds(storage) && builds(localStorageSigningSecret),
    }),
  };
}

// Vercel gives each function instance its own ephemeral disk, so LocalFsStorageAdapter's bytes
// written by one instance (e.g. the relay step) are invisible to another (e.g. analyse) — the
// Postgres-backed adapter is required there regardless of STORAGE_BACKEND. Off Vercel,
// STORAGE_BACKEND opts a host with no shared disk (or a manual test of the Postgres path) into it too.
function resolveStorageBackend(): "local" | "postgres" {
  if (optionalEnv("VERCEL") !== undefined) return "postgres";
  const raw = optionalEnv("STORAGE_BACKEND");
  if (raw === undefined || raw === "local") return "local";
  if (raw === "postgres") return "postgres";
  // Reuses ConfigError's shape (variableName, configStatus().storage reads as unbuildable) rather
  // than a bare Error — a typo like "postgress" must fail loudly, never silently fall back to a
  // filesystem adapter that Vercel's ephemeral disk can't support.
  const error = new ConfigError("STORAGE_BACKEND");
  error.message = `STORAGE_BACKEND must be "postgres", "local", or unset (got ${JSON.stringify(raw)})`;
  throw error;
}

function buildProductionStorageAdapter(db: Db, signingSecret: () => string): StorageAdapter {
  const accessCheck = canAccess;
  // The secret is required either way, read here (not at module scope) so a missing/short one fails
  // when the adapter is first built, not at import time.
  if (resolveStorageBackend() === "postgres") {
    return new PostgresStorageAdapter({ db, accessCheck, signingSecret: signingSecret() });
  }
  return new LocalFsStorageAdapter({ accessCheck, signingSecret: signingSecret() });
}

/** The real env-driven ContainerOptions; exported for tests that exercise this wiring directly over their own database. */
export function productionContainerOptions(db: Db): ContainerOptions {
  const localStorageSigningSecret = () => requireEnv("LOCAL_STORAGE_SIGNING_SECRET");
  return {
    db,
    // The adapter validates the secret, so a bad one fails here rather than on the first upload.
    storage: () => buildProductionStorageAdapter(db, localStorageSigningSecret),
    llm: () => ({ primary: createGeminiClient(), secondary: createGemmaClient() }),
    localStorageSigningSecret,
    primaryModelId: geminiModelId(),
  };
}

let installed: Container | undefined;

/**
 * The installed production Container, built and cached on first call; throws in a test process
 * with none installed — call setContainerForTests first.
 */
export function getContainer(): Container {
  if (installed) return installed;
  // The production container opens an on-disk store; a test must never reach it by accident.
  if (process.env.NODE_ENV === "test") {
    throw new Error("No container installed: call setContainerForTests(createContainer({...})) first.");
  }
  installed = createContainer(productionContainerOptions(getDb()));
  return installed;
}

/** Installs (or clears, with undefined) the container getContainer() returns; tests use this to swap in fakes. */
export function setContainerForTests(container: Container | undefined): void {
  installed = container;
}
