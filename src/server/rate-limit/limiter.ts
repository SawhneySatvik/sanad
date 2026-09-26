/**
 * Three-tier rate limiter: per-principal, per-IP (hashed) and global-per-provider buckets, each an
 * atomic `INSERT ... ON CONFLICT ... RETURNING`, never wrapped in a transaction and never spanning
 * an LLM call. Fixed-minute windows (plus fixed UTC-hour windows for the auth-specific buckets and
 * fixed UTC-day windows for the daily LLM-call caps), keyed by an injectable `Clock` rather than
 * `Date.now()` directly, so window-rollover is deterministic in tests — this lets a caller achieve
 * up to ~2x the nominal limit by timing requests across a window boundary, an accepted property at
 * this project's scale.
 */

import { sql, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { globalLlmRateLimit, ipRateLimitBuckets, rateLimitBuckets } from "@/db/schema";
import { AppError, safeMessageFor } from "@/server/core/errors";
import { ConfigError, optionalEnv } from "@/server/core/env";
import type { Principal } from "@/server/core/types";
import { normalizeIp, UNKNOWN_CLIENT_IP } from "./client-ip";
import { hashAuthEmail, hashIp } from "./ip-hash";

/** Time source every limiter check goes through, so window-rollover is deterministic in tests. */
export interface Clock {
  now(): Date;
}

/** The real wall-clock Clock. */
export const systemClock: Clock = { now: () => new Date() };

// Minute-granularity, UTC, fixed-width. Not relied on for cleanup ordering: pruning below goes by
// `updated_at`, never by parsing this string, matching the prod cleanup job's own contract.
function windowKeyFor(now: Date): string {
  return now.toISOString().slice(0, 16);
}

// "2026-09-23": the UTC day, never the same shape as a minute key.
function dayKeyFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// "2026-09-23T10": the UTC hour — coarser than windowKeyFor's minute, finer than dayKeyFor's day.
function hourKeyFor(now: Date): string {
  return now.toISOString().slice(0, 13);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

function secondsUntilNext(windowMs: number, now: Date): number {
  const msIntoWindow = now.getTime() % windowMs;
  return Math.ceil((windowMs - msIntoWindow) / 1000);
}

/** The rate-limit bucket key for a principal: `user:<id>` or `guest:<id>`. */
export function principalKeyFor(principal: Principal): string {
  return principal.type === "user" ? `user:${principal.userId}` : `guest:${principal.guestSessionId}`;
}

// The daily and per-call counters live in the same tables as the per-minute ones, under their own
// key prefix, so a lookup by key never mixes two counters.
function principalDailyKeyFor(principal: Principal): string {
  return `day:${principalKeyFor(principal)}`;
}

// Normalized before hashing, so an unparseable value falls back to the shared UNKNOWN_CLIENT_IP bucket.
function ipHashFor(ip: string): string {
  const normalized = normalizeIp(ip);
  return hashIp(normalized.ok ? normalized.value : UNKNOWN_CLIENT_IP);
}

// Own key prefixes (not just a distinct window shape) so a request-count bucket never shares a row
// with the generic per-IP/per-principal tiers every other route pays — a credential-stuffing script
// against sign-in/sign-up is throttled well below the generic tier, on its own budget.
function authIpMinuteKeyFor(ip: string): string {
  return `authip:${ipHashFor(ip)}`;
}
function authIpHourKeyFor(ip: string): string {
  return `authip-hour:${ipHashFor(ip)}`;
}
function authEmailMinuteKeyFor(email: string): string {
  return `authemail:${hashAuthEmail(email)}`;
}
function authEmailHourKeyFor(email: string): string {
  return `authemail-hour:${hashAuthEmail(email)}`;
}

async function incrementPrincipalBucket(db: Db, principalKey: string, windowKey: string): Promise<number> {
  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ principalKey, windowKey, requestCount: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.principalKey, rateLimitBuckets.windowKey],
      set: { requestCount: sql`${rateLimitBuckets.requestCount} + 1`, updatedAt: sql`now()` },
    })
    .returning({ requestCount: rateLimitBuckets.requestCount });
  return row.requestCount;
}

async function incrementIpBucket(db: Db, ipKey: string, windowKey: string): Promise<number> {
  const [row] = await db
    .insert(ipRateLimitBuckets)
    .values({ ipKey, windowKey, requestCount: 1 })
    .onConflictDoUpdate({
      target: [ipRateLimitBuckets.ipKey, ipRateLimitBuckets.windowKey],
      set: { requestCount: sql`${ipRateLimitBuckets.requestCount} + 1`, updatedAt: sql`now()` },
    })
    .returning({ requestCount: ipRateLimitBuckets.requestCount });
  return row.requestCount;
}

async function incrementProviderBucket(db: Db, providerKey: string, windowKey: string): Promise<number> {
  const [row] = await db
    .insert(globalLlmRateLimit)
    .values({ providerKey, windowKey, requestCount: 1 })
    .onConflictDoUpdate({
      target: [globalLlmRateLimit.providerKey, globalLlmRateLimit.windowKey],
      set: { requestCount: sql`${globalLlmRateLimit.requestCount} + 1`, updatedAt: sql`now()` },
    })
    .returning({ requestCount: globalLlmRateLimit.requestCount });
  return row.requestCount;
}

/**
 * Provider HTTP requests one LLM call can make: the original plus one schema-repair retry.
 * Must equal MAX_ATTEMPTS in llm/structured-output.ts; with-global-limit.test.ts fails if they drift.
 */
export const MAX_HTTP_ATTEMPTS_PER_CALL = 2;

// Assumed provider RPM ceilings, not verified against a live account. Default limits below are
// floor(assumedRpm / MAX_HTTP_ATTEMPTS_PER_CALL) so the worst-case HTTP rate stays under quota even
// when every call retries. The fallback chain charges one of these buckets per tier attempt, so this
// bound holds for every tier independently, not just the first one on each side.
//
// gemini and gemini_fallback share GEMINI_API_KEY but are separate free-tier daily quotas
// (20 requests/day/model); with no live per-minute measurement for the second model, it assumes the
// same RPM ceiling as the first. gemma_google is also served through the Gemini API on that same
// key, so it assumes the same ceiling too, rather than the NIM/OpenRouter-derived value below. NIM
// and OpenRouter share one bucket rather than getting their own: it's not a shared per-key quota the
// way the three Gemini-API tiers are, so there's nothing to conflate by keeping them together, and a
// combined cap of 10/min already bounds each gateway to at most 20 HTTP requests/min on its own — a
// split could only reduce throughput on a dead account (NIM) and an external shared pool
// (OpenRouter's `:free` route), never protect a quota that matters.
const GEMINI_ASSUMED_RPM = 15;
const GEMINI_FALLBACK_ASSUMED_RPM = 15;
const GEMMA_ASSUMED_RPM = 20;
const GEMMA_GOOGLE_ASSUMED_RPM = 30;

/**
 * Must sit below every global provider default so a single guest/user can never consume a whole
 * shared quota alone. Counts LLM calls per principal per minute, charged once per logical call via
 * withCallerLimit at the LlmClient boundary — never per inbound HTTP request, since one Ask
 * request can fan out into several Gemini calls. Non-LLM routes are never principal-charged.
 */
export const DEFAULT_PRINCIPAL_LIMIT = 5;
/** Inbound requests per IP per minute, on every route — universal even when no LLM call is made. */
export const DEFAULT_IP_LIMIT = 60;
/**
 * LLM calls per IP per minute, charged per call like the principal tier. A guest principal is
 * self-issued, so a script that sheds its cookie gets a fresh principal bucket every time; its IP
 * bucket stays the same. Equal to the principal limit, so cycling cookies buys nothing, and for the
 * same reason below every global provider default: one IP can never fill a shared bucket alone.
 */
export const DEFAULT_IP_LLM_LIMIT = DEFAULT_PRINCIPAL_LIMIT;

// Free-tier requests per day of the primary model (Gemini 3.5 Flash Lite); each model has its own.
const PRIMARY_MODEL_REQUESTS_PER_DAY = 500;

/**
 * LLM calls per principal per UTC day: a few full demos (analyses, Asks, Prepare, Draft, Compare).
 * Even if every call needed its repair retry, one principal spends under a third of the primary
 * model's day, and the fallback tiers carry their own separate quotas behind it.
 */
export const DEFAULT_PRINCIPAL_DAILY_LIMIT = Math.floor(PRIMARY_MODEL_REQUESTS_PER_DAY / MAX_HTTP_ATTEMPTS_PER_CALL / 4);
/**
 * LLM calls per IP per UTC day: two principals' days, for people sharing one NAT. Still under the
 * primary model's day at one request per call, so cycling cookies can't drain it.
 */
export const DEFAULT_IP_DAILY_LIMIT = DEFAULT_PRINCIPAL_DAILY_LIMIT * 2;

/**
 * Sign-in/sign-up-specific limits, charged before any Supabase call and independent of every other
 * tier above: a credential-stuffing script rotating IPs is capped by the email bucket, one rotating
 * emails against one IP is capped by the IP bucket, and either working slowly enough to dodge the
 * per-minute cap still hits the per-hour one.
 */
export const DEFAULT_AUTH_IP_PER_MINUTE = 5;
export const DEFAULT_AUTH_IP_PER_HOUR = 20;
export const DEFAULT_AUTH_EMAIL_PER_MINUTE = 5;
export const DEFAULT_AUTH_EMAIL_PER_HOUR = 20;

/**
 * Which shared quota a global bucket counts against. Two keys can point at the same underlying
 * provider account (gemini/gemini_fallback/gemma_google all use GEMINI_API_KEY) when the provider
 * meters them as separate per-model quotas — this type tracks quota pools, not provider companies.
 */
export type ProviderKey = "gemini" | "gemini_fallback" | "gemma" | "gemma_google";

/** Per-quota default call-level limit, derived from the assumed RPM ceilings above. */
export const DEFAULT_GLOBAL_LIMIT: Record<ProviderKey, number> = {
  gemini: Math.floor(GEMINI_ASSUMED_RPM / MAX_HTTP_ATTEMPTS_PER_CALL),
  gemini_fallback: Math.floor(GEMINI_FALLBACK_ASSUMED_RPM / MAX_HTTP_ATTEMPTS_PER_CALL),
  gemma: Math.floor(GEMMA_ASSUMED_RPM / MAX_HTTP_ATTEMPTS_PER_CALL),
  gemma_google: Math.floor(GEMMA_GOOGLE_ASSUMED_RPM / MAX_HTTP_ATTEMPTS_PER_CALL),
};
const GLOBAL_LIMIT_ENV_VAR: Record<ProviderKey, string> = {
  gemini: "RATE_LIMIT_GEMINI_PER_MINUTE",
  gemini_fallback: "RATE_LIMIT_GEMINI_FALLBACK_PER_MINUTE",
  gemma: "RATE_LIMIT_GEMMA_PER_MINUTE",
  gemma_google: "RATE_LIMIT_GEMMA_GOOGLE_PER_MINUTE",
};

// Plain positive integers only: Number() accepts "1e9" and "0x10", which would silently lift the limit.
const DECIMAL_INTEGER_RE = /^[1-9]\d*$/;
// A sane ceiling on any override — without this, a typo'd env var (or "1e9" if the regex above
// were ever loosened) could disable the limiter entirely rather than merely misconfigure it.
const MAX_ENV_LIMIT = 10_000;
// Warns about a given bad env var at most once per process, not once per call.
const warnedInvalidEnvVars = new Set<string>();

function warnInvalidEnvOnce(name: string, detail: string): void {
  if (warnedInvalidEnvVars.has(name)) return;
  warnedInvalidEnvVars.add(name);
  // Naming the bad value is safe here — these are rate limits, never secrets.
  console.warn(`${name} ${detail}.`);
}

// An invalid override falls back to the built-in default; one over MAX_ENV_LIMIT is clamped
// instead of discarded. A misconfigured env var must never take the app down.
function envLimit(name: string): number | undefined {
  const raw = optionalEnv(name);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!DECIMAL_INTEGER_RE.test(trimmed)) {
    warnInvalidEnvOnce(name, `is not a plain positive decimal integer (got ${JSON.stringify(raw)}) — using the built-in default`);
    return undefined;
  }
  const parsed = Number(trimmed);
  if (parsed > MAX_ENV_LIMIT) {
    warnInvalidEnvOnce(name, `(${parsed}) exceeds the maximum allowed limit (${MAX_ENV_LIMIT}) — clamped to ${MAX_ENV_LIMIT}`);
    return MAX_ENV_LIMIT;
  }
  return parsed;
}

/**
 * Throws a ConfigError if `limit` is set but not a finite integer >= 1 — a programming error, so
 * it fails loud instead of falling back like `envLimit`.
 */
export function assertValidLimitOverride(optionName: string, limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1) {
    const err = new ConfigError(optionName);
    err.message = `${optionName} (opts.limit) must be a finite integer >= 1, got ${String(limit)}.`;
    throw err;
  }
}

function resolveLimit(envVar: string, builtIn: number, override?: number): number {
  assertValidLimitOverride(envVar, override);
  return override ?? envLimit(envVar) ?? builtIn;
}

function resolvePrincipalLimit(override?: number): number {
  return resolveLimit("RATE_LIMIT_PRINCIPAL_PER_MINUTE", DEFAULT_PRINCIPAL_LIMIT, override);
}

function resolveIpLimit(override?: number): number {
  return resolveLimit("RATE_LIMIT_IP_PER_MINUTE", DEFAULT_IP_LIMIT, override);
}

function resolveGlobalLimit(providerKey: ProviderKey, override?: number): number {
  return resolveLimit(GLOBAL_LIMIT_ENV_VAR[providerKey], DEFAULT_GLOBAL_LIMIT[providerKey], override);
}

function resolveAuthIpMinuteLimit(override?: number): number {
  return resolveLimit("RATE_LIMIT_AUTH_IP_PER_MINUTE", DEFAULT_AUTH_IP_PER_MINUTE, override);
}
function resolveAuthIpHourLimit(override?: number): number {
  return resolveLimit("RATE_LIMIT_AUTH_IP_PER_HOUR", DEFAULT_AUTH_IP_PER_HOUR, override);
}
function resolveAuthEmailMinuteLimit(override?: number): number {
  return resolveLimit("RATE_LIMIT_AUTH_EMAIL_PER_MINUTE", DEFAULT_AUTH_EMAIL_PER_MINUTE, override);
}
function resolveAuthEmailHourLimit(override?: number): number {
  return resolveLimit("RATE_LIMIT_AUTH_EMAIL_PER_HOUR", DEFAULT_AUTH_EMAIL_PER_HOUR, override);
}

/** The outcome of one rate-limit check. */
export interface LimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  // Seconds until the current fixed window (minute or UTC day) rolls over. 0 when `allowed` is
  // true — a caller under the limit has nothing to retry.
  retryAfterSeconds: number;
}

function buildResult(count: number, limit: number, windowMs: number, now: Date): LimitResult {
  const allowed = count <= limit;
  return { allowed, count, limit, retryAfterSeconds: allowed ? 0 : secondsUntilNext(windowMs, now) };
}

function enforce(result: LimitResult): LimitResult {
  if (!result.allowed) {
    throw new AppError("RATE_LIMITED", safeMessageFor("RATE_LIMITED"), { retryAfterSeconds: result.retryAfterSeconds });
  }
  return result;
}

/** Options for a per-principal limit check: an override limit and/or clock, for tests. */
export interface PrincipalLimitOptions {
  limit?: number;
  clock?: Clock;
}

/** Increments and checks the per-principal bucket without throwing; use enforcePrincipalLimit to reject over the limit. */
export async function checkPrincipalLimit(
  db: Db,
  principal: Principal,
  opts: PrincipalLimitOptions = {},
): Promise<LimitResult> {
  const limit = resolvePrincipalLimit(opts.limit); // validated/resolved before the increment
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementPrincipalBucket(db, principalKeyFor(principal), windowKeyFor(now));
  return buildResult(count, limit, MINUTE_MS, now);
}

/** Throws RATE_LIMITED when the principal is over its per-minute limit. */
export async function enforcePrincipalLimit(
  db: Db,
  principal: Principal,
  opts: PrincipalLimitOptions = {},
): Promise<LimitResult> {
  return enforce(await checkPrincipalLimit(db, principal, opts));
}

/** Increments and checks the principal's LLM calls this UTC day without throwing. */
export async function checkPrincipalDailyLimit(
  db: Db,
  principal: Principal,
  opts: PrincipalLimitOptions = {},
): Promise<LimitResult> {
  const limit = resolveLimit("RATE_LIMIT_PRINCIPAL_PER_DAY", DEFAULT_PRINCIPAL_DAILY_LIMIT, opts.limit);
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementPrincipalBucket(db, principalDailyKeyFor(principal), dayKeyFor(now));
  return buildResult(count, limit, DAY_MS, now);
}

/** Throws RATE_LIMITED, retryable at the next UTC midnight, when the principal is over its daily LLM-call cap. */
export async function enforcePrincipalDailyLimit(
  db: Db,
  principal: Principal,
  opts: PrincipalLimitOptions = {},
): Promise<LimitResult> {
  return enforce(await checkPrincipalDailyLimit(db, principal, opts));
}

/** Options for a per-IP limit check: an override limit and/or clock, for tests. */
export interface IpLimitOptions {
  limit?: number;
  clock?: Clock;
}

/**
 * Increments and checks the per-request IP bucket without throwing; `ip` is normalized before
 * hashing, so an unparseable value falls back to the shared UNKNOWN_CLIENT_IP bucket. Every inbound
 * request passes through here, so it also prunes stale bucket rows, at most every PRUNE_INTERVAL_MS.
 */
export async function checkIpLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  const limit = resolveIpLimit(opts.limit); // validated/resolved before the increment
  const now = (opts.clock ?? systemClock).now();
  await pruneIfDue(db);
  const count = await incrementIpBucket(db, ipHashFor(ip), windowKeyFor(now));
  return buildResult(count, limit, MINUTE_MS, now);
}

/** Throws RATE_LIMITED when the IP is over its per-minute limit. */
export async function enforceIpLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  return enforce(await checkIpLimit(db, ip, opts));
}

/** Increments and checks the IP's LLM calls this minute — a bucket separate from the per-request one — without throwing. */
export async function checkIpLlmLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  const limit = resolveLimit("RATE_LIMIT_IP_LLM_PER_MINUTE", DEFAULT_IP_LLM_LIMIT, opts.limit);
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementIpBucket(db, `llm:${ipHashFor(ip)}`, windowKeyFor(now));
  return buildResult(count, limit, MINUTE_MS, now);
}

/** Throws RATE_LIMITED when the IP is over its per-minute LLM-call limit. */
export async function enforceIpLlmLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  return enforce(await checkIpLlmLimit(db, ip, opts));
}

/** Increments and checks the IP's LLM calls this UTC day without throwing. */
export async function checkIpLlmDailyLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  const limit = resolveLimit("RATE_LIMIT_IP_LLM_PER_DAY", DEFAULT_IP_DAILY_LIMIT, opts.limit);
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementIpBucket(db, `llm-day:${ipHashFor(ip)}`, dayKeyFor(now));
  return buildResult(count, limit, DAY_MS, now);
}

/** Throws RATE_LIMITED, retryable at the next UTC midnight, when the IP is over its daily LLM-call cap. */
export async function enforceIpLlmDailyLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  return enforce(await checkIpLlmDailyLimit(db, ip, opts));
}

/** Increments and checks the sign-in/sign-up IP bucket (per minute) without throwing — its own tier, separate from the generic per-request IP limit every route pays. */
export async function checkAuthIpLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  const limit = resolveAuthIpMinuteLimit(opts.limit);
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementIpBucket(db, authIpMinuteKeyFor(ip), windowKeyFor(now));
  return buildResult(count, limit, MINUTE_MS, now);
}

/** Throws RATE_LIMITED when the IP is over its per-minute sign-in/sign-up limit. */
export async function enforceAuthIpLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  return enforce(await checkAuthIpLimit(db, ip, opts));
}

/** Increments and checks the sign-in/sign-up IP bucket (per hour) without throwing. */
export async function checkAuthIpHourlyLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  const limit = resolveAuthIpHourLimit(opts.limit);
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementIpBucket(db, authIpHourKeyFor(ip), hourKeyFor(now));
  return buildResult(count, limit, HOUR_MS, now);
}

/** Throws RATE_LIMITED when the IP is over its hourly sign-in/sign-up limit. */
export async function enforceAuthIpHourlyLimit(db: Db, ip: string, opts: IpLimitOptions = {}): Promise<LimitResult> {
  return enforce(await checkAuthIpHourlyLimit(db, ip, opts));
}

/** Increments and checks the sign-in/sign-up per-email bucket (per minute) without throwing — keyed by HMAC(RATE_LIMIT_IP_HASH_SECRET, lowercased email), never the raw email. */
export async function checkAuthEmailLimit(db: Db, email: string, opts: PrincipalLimitOptions = {}): Promise<LimitResult> {
  const limit = resolveAuthEmailMinuteLimit(opts.limit);
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementPrincipalBucket(db, authEmailMinuteKeyFor(email), windowKeyFor(now));
  return buildResult(count, limit, MINUTE_MS, now);
}

/** Throws RATE_LIMITED when the email is over its per-minute sign-in/sign-up limit. */
export async function enforceAuthEmailLimit(db: Db, email: string, opts: PrincipalLimitOptions = {}): Promise<LimitResult> {
  return enforce(await checkAuthEmailLimit(db, email, opts));
}

/** Increments and checks the sign-in/sign-up per-email bucket (per hour) without throwing. */
export async function checkAuthEmailHourlyLimit(db: Db, email: string, opts: PrincipalLimitOptions = {}): Promise<LimitResult> {
  const limit = resolveAuthEmailHourLimit(opts.limit);
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementPrincipalBucket(db, authEmailHourKeyFor(email), hourKeyFor(now));
  return buildResult(count, limit, HOUR_MS, now);
}

/** Throws RATE_LIMITED when the email is over its hourly sign-in/sign-up limit. */
export async function enforceAuthEmailHourlyLimit(db: Db, email: string, opts: PrincipalLimitOptions = {}): Promise<LimitResult> {
  return enforce(await checkAuthEmailHourlyLimit(db, email, opts));
}

/** Overrides for enforceAuthRateLimits's four buckets; unset means the env var or the built-in default. */
export interface AuthRateLimitOptions {
  ipPerMinute?: number;
  ipPerHour?: number;
  emailPerMinute?: number;
  emailPerHour?: number;
  clock?: Clock;
}

/**
 * Charges the sign-in/sign-up-specific IP and email buckets, IP before email, each its own atomic
 * increment — called once per attempt, before any Supabase call. IP first means a request already
 * over its own IP budget never also charges (and can't help exhaust) an innocent victim's email
 * bucket.
 */
export async function enforceAuthRateLimits(db: Db, ip: string, email: string, opts: AuthRateLimitOptions = {}): Promise<void> {
  await enforceAuthIpLimit(db, ip, { limit: opts.ipPerMinute, clock: opts.clock });
  await enforceAuthIpHourlyLimit(db, ip, { limit: opts.ipPerHour, clock: opts.clock });
  await enforceAuthEmailLimit(db, email, { limit: opts.emailPerMinute, clock: opts.clock });
  await enforceAuthEmailHourlyLimit(db, email, { limit: opts.emailPerHour, clock: opts.clock });
}

/** Options for a per-provider global limit check: an override limit and/or clock, for tests. */
export interface GlobalLimitOptions {
  limit?: number;
  clock?: Clock;
}

/** Increments and checks the per-provider global bucket without throwing. */
export async function checkGlobalLimit(
  db: Db,
  providerKey: ProviderKey,
  opts: GlobalLimitOptions = {},
): Promise<LimitResult> {
  const limit = resolveGlobalLimit(providerKey, opts.limit); // validated/resolved before the increment
  const now = (opts.clock ?? systemClock).now();
  const count = await incrementProviderBucket(db, providerKey, windowKeyFor(now));
  return buildResult(count, limit, MINUTE_MS, now);
}

/** Throws RATE_LIMITED when the provider's shared quota is exhausted for this window. */
export async function enforceGlobalLimit(
  db: Db,
  providerKey: ProviderKey,
  opts: GlobalLimitOptions = {},
): Promise<LimitResult> {
  return enforce(await checkGlobalLimit(db, providerKey, opts));
}

/** Rows deleted per bucket table by pruneRateLimitBuckets. */
export interface PruneResult {
  principal: number;
  ip: number;
  global: number;
}

/** Deletes bucket rows older than `olderThanMinutes`, by `updated_at`; returns rows deleted per table. */
export async function pruneRateLimitBuckets(
  db: Db,
  olderThanMinutes: number,
  clock: Clock = systemClock,
): Promise<PruneResult> {
  const cutoff = new Date(clock.now().getTime() - olderThanMinutes * MINUTE_MS);
  const principalDeleted = await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.updatedAt, cutoff))
    .returning({ principalKey: rateLimitBuckets.principalKey });
  const ipDeleted = await db
    .delete(ipRateLimitBuckets)
    .where(lt(ipRateLimitBuckets.updatedAt, cutoff))
    .returning({ ipKey: ipRateLimitBuckets.ipKey });
  const globalDeleted = await db
    .delete(globalLlmRateLimit)
    .where(lt(globalLlmRateLimit.updatedAt, cutoff))
    .returning({ providerKey: globalLlmRateLimit.providerKey });
  return { principal: principalDeleted.length, ip: ipDeleted.length, global: globalDeleted.length };
}

// Must outlive the longest window, or a prune would reset a daily count mid-day; the production
// cleanup job keeps the same 2 days.
const BUCKET_RETENTION_MINUTES = 2 * 24 * 60;
/** How often, at most, one process prunes stale bucket rows on the request path. */
export const PRUNE_INTERVAL_MS = 10 * MINUTE_MS;
let nextPruneAtMs = 0;

// Nothing else prunes a local database; in production the scheduled cleanup job does, and this is a
// cheap extra. Wall-clock time, never an injected Clock: a test clock set in the future would put
// the cutoff in the future and delete live buckets.
async function pruneIfDue(db: Db): Promise<void> {
  const nowMs = Date.now();
  if (nowMs < nextPruneAtMs) return;
  nextPruneAtMs = nowMs + PRUNE_INTERVAL_MS;
  await pruneRateLimitBuckets(db, BUCKET_RETENTION_MINUTES);
}
