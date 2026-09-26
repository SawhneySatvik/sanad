/**
 * Factory functions that read env vars and build real (network-capable) LlmClient instances — the
 * only place in this module that touches process.env. createRateLimitedLlmClient flattens the
 * primary (createGeminiClient) and secondary (createGemmaClient) sides into one FallbackLlmClient
 * with one deadline: gemini-3.5-flash-lite, gemini-3.1-flash-lite, then Gemma on Google AI Studio, NIM,
 * and OpenRouter — Google's Gemma runs first because NIM gave this account no response at all, and
 * OpenRouter's free Gemma shares Google AI Studio's pool. Every tier has its own circuit breaker.
 */

import { isE2eMode, optionalEnv, requireEnv } from "@/server/core/env";
import { CircuitBreaker } from "./circuit-breaker";
import { FallbackLlmClient, type LlmTier } from "./fallback";
import { DEFAULT_GEMINI_MODEL, GeminiLlmClient } from "./gemini";
import { GemmaLlmClient } from "./gemma";

const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// --- e2e transport redirect (tests/e2e/support/fake-provider) --------------------------------
//
// Honoured only when isE2eMode() is true — which is itself never true in production, see
// core/env.ts. Every create*Client below stays byte-identical to its production shape when this
// returns undefined, which it always does outside the e2e harness.

const E2E_PROVIDER_URL_VAR = "SABOOT_E2E_PROVIDER_URL";
// Loopback only: this is the one server-side barrier stopping a misconfigured fake-provider URL
// from pointing live provider traffic anywhere but a process on this machine — Playwright's own
// non-localhost abort (playwright.config.ts) only ever sees browser-issued traffic, never this.
// "[::1]" not "::1": new URL(...).hostname keeps the brackets for a bracketed IPv6 literal.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const GOOGLE_GENAI_HOSTNAME = "generativelanguage.googleapis.com";
const E2E_NIM_PATH = "/nim/v1";
const E2E_OPENROUTER_PATH = "/openrouter/v1";

// undefined whenever the e2e harness isn't active. Once it IS active (isE2eMode() true — which is
// itself never true in production), a missing SABOOT_E2E_PROVIDER_URL is refused rather than
// silently falling back to a production-shaped client that could reach a live provider from what's
// supposed to be a sandboxed run: fail closed, never fail open.
function e2eProviderBaseUrl(): string | undefined {
  if (!isE2eMode()) return undefined;
  const raw = optionalEnv(E2E_PROVIDER_URL_VAR);
  if (raw === undefined) {
    throw new Error(
      `${E2E_PROVIDER_URL_VAR} must be set whenever SABOOT_E2E=1 — refusing to build a provider client that ` +
        "would silently skip the e2e redirect and reach a live host.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${E2E_PROVIDER_URL_VAR} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(`${E2E_PROVIDER_URL_VAR} must be a loopback URL (127.0.0.1/localhost), got host "${parsed.hostname}"`);
  }
  return parsed.origin;
}

function toRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

// Rewrites requests bound for the real Gemini Developer API host, preserving the path and query the
// SDK built. This function is only ever constructed while isE2eMode() is true (see
// e2eGeminiFetchOverride below), so ANY other destination — an SDK internal call this module didn't
// anticipate, a bug, anything — is refused rather than quietly forwarded to a live host: fail
// closed, never fail open. Declared async so a throw here rejects the returned promise, matching a
// real fetch's own contract (the same reasoning tests/setup/no-network.ts's guarded fetch uses).
function e2eGeminiFetch(baseUrl: string): typeof fetch {
  return async (input, init) => {
    const original = toRequestUrl(input);
    if (original.hostname !== GOOGLE_GENAI_HOSTNAME) {
      throw new Error(`e2e mode: refusing to reach "${original.hostname}" — only ${GOOGLE_GENAI_HOSTNAME} may be redirected here`);
    }
    const target = new URL(`${original.pathname}${original.search}`, baseUrl);
    return input instanceof Request ? fetch(new Request(target, input)) : fetch(target, init);
  };
}

// Handed to every GeminiLlmClient this module builds (primary, its fallback model, and Gemma
// hosted on the Gemini API) — all three go through the same SDK and the same real host.
function e2eGeminiFetchOverride(): typeof fetch | undefined {
  const base = e2eProviderBaseUrl();
  return base === undefined ? undefined : e2eGeminiFetch(base);
}

// NIM and OpenRouter each get their own path prefix on the fake, so its request log shows which
// tier a given call came through even though both speak the same OpenAI-compatible shape.
function e2eGemmaBaseUrl(realBaseUrl: string, e2ePath: string): string {
  const base = e2eProviderBaseUrl();
  return base === undefined ? realBaseUrl : `${base}${e2ePath}`;
}

// Backstop per client call for a caller that passes no `timeoutMs`; every service passes its own
// per-operation budget instead (llm/timeouts.ts), which also bounds the whole fallback chain.
const DEFAULT_TIMEOUT_MS = 45_000;

// A second Flash Lite model: its own 500-requests-a-day free quota, separate from the primary's.
const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";
// Each gateway spells the same Gemma model differently: Google AI Studio uses the bare id, NIM a
// `google/` prefix, OpenRouter's free route a `:free` suffix.
const DEFAULT_GEMMA_MODEL_GOOGLE = "gemma-4-31b-it";
const DEFAULT_GEMMA_MODEL_NIM = "google/gemma-4-31b-it";
const DEFAULT_GEMMA_MODEL_OPENROUTER = "google/gemma-4-31b-it:free";

/** The Gemini model id this process sends — the composition root keys the analysis cache on it. */
export function geminiModelId(): string {
  return optionalEnv("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL;
}

/** The primary model, then a second Gemini model with its own quota; both read native documents, and the second gets no thinking budget. */
export function createGeminiClient(): FallbackLlmClient {
  const apiKey = requireEnv("GEMINI_API_KEY");
  const fetchOverride = e2eGeminiFetchOverride();
  return new FallbackLlmClient(
    withBreaker(
      "gemini",
      new GeminiLlmClient({ apiKey, model: geminiModelId(), defaultTimeoutMs: DEFAULT_TIMEOUT_MS, fetch: fetchOverride }),
      "gemini",
    ),
    withBreaker(
      "gemini",
      new GeminiLlmClient({
        apiKey,
        model: optionalEnv("GEMINI_FALLBACK_MODEL") ?? DEFAULT_GEMINI_FALLBACK_MODEL,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        sendThinkingBudget: false,
        fetch: fetchOverride,
      }),
      "gemini_fallback",
    ),
  );
}

/** Gemma served by the Gemini API itself: the same native structured output as Gemini, but not known to read raw files, and sent no thinking budget. */
export function createGoogleGemmaClient(): GeminiLlmClient {
  return new GeminiLlmClient({
    apiKey: requireEnv("GEMINI_API_KEY"),
    model: optionalEnv("GEMMA_MODEL_GOOGLE") ?? DEFAULT_GEMMA_MODEL_GOOGLE,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    nativeDocumentInput: false,
    sendThinkingBudget: false,
    fetch: e2eGeminiFetchOverride(),
  });
}

/** NIM's own model override, then the shared `GEMMA_MODEL` for a single-var setup, then NIM's default. */
export function createNimGemmaClient(): GemmaLlmClient {
  return new GemmaLlmClient({
    apiKey: requireEnv("NVIDIA_API_KEY"),
    baseURL: e2eGemmaBaseUrl(NVIDIA_NIM_BASE_URL, E2E_NIM_PATH),
    model: optionalEnv("GEMMA_MODEL_NIM") ?? optionalEnv("GEMMA_MODEL") ?? DEFAULT_GEMMA_MODEL_NIM,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

/** OpenRouter's own model override, then the shared `GEMMA_MODEL`, then OpenRouter's default. */
export function createOpenRouterGemmaClient(): GemmaLlmClient {
  return new GemmaLlmClient({
    apiKey: requireEnv("OPENROUTER_API_KEY"),
    baseURL: e2eGemmaBaseUrl(OPENROUTER_BASE_URL, E2E_OPENROUTER_PATH),
    model: optionalEnv("GEMMA_MODEL_OPENROUTER") ?? optionalEnv("GEMMA_MODEL") ?? DEFAULT_GEMMA_MODEL_OPENROUTER,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
}

/**
 * The Gemma side. Google-hosted Gemma gets its own rate-limit key (gemma_google): it shares
 * GEMINI_API_KEY but is metered separately. NIM and OpenRouter share the "gemma" key. Compose only
 * through `createRateLimitedLlmClient`: a bare FallbackLlmClient skips the rate limits.
 */
export function createGemmaClient(): FallbackLlmClient {
  return new FallbackLlmClient(
    withBreaker("google", createGoogleGemmaClient(), "gemma_google"),
    withBreaker("nim", createNimGemmaClient(), "gemma"),
    withBreaker("openrouter", createOpenRouterGemmaClient(), "gemma"),
  );
}

function withBreaker(gateway: string, client: GeminiLlmClient | GemmaLlmClient, rateLimitKey: string): LlmTier {
  return { client, breaker: new CircuitBreaker(`${gateway}:${client.model}`), rateLimitKey };
}

/**
 * Direct access to the e2e-mode helpers above, for their own unit tests only — never imported by
 * the factory functions' callers, and never a second public surface for building a client.
 */
export const e2eProvidersTestHooks = { e2eProviderBaseUrl, e2eGeminiFetch, e2eGemmaBaseUrl };
