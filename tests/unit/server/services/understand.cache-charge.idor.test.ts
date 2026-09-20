import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContainer, type RateLimitOverrides, type ServiceDeps } from "@/server/container";
import type { Principal } from "@/server/core/types";
import { analyze, DocumentAnalysisError } from "@/server/services/understand";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, FIXTURES_DIR, guestA, guestB, type Harness, leaseOutput, MIME, TEST_MODEL_ID } from "@tests/support/services/understand";

// The analysis cache is keyed by document content and shared across principals. A hit must cost the
// caller exactly what the model call it replaces would — every tier the production client charges
// (principal and client IP, per minute and per day) — or a caller at any one of those limits learns
// whether someone else analyzed the exact same text: served for one, RATE_LIMITED for the other.
// Deps come from the real container.forRequest, so hit and miss are charged by the same composition.

const CLOCK = { now: () => new Date("2026-09-23T10:00:30.000Z") };
const GENEROUS: RateLimitOverrides = {
  ipPerMinute: 1000,
  principalPerMinute: 50,
  ipLlmPerMinute: 50,
  principalPerDay: 50,
  ipLlmPerDay: 50,
  primaryPerMinute: 1000,
  secondaryPerMinute: 1000,
  clock: CLOCK,
};
// Distinct IPs, so the victim's own calls never spend the attacker's IP buckets.
const VICTIM_IP = "198.51.100.7";
const ATTACKER_IP = "203.0.113.9";

let h: Harness;
let primary: FakeLlmClient;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

function depsFor(rateLimits: RateLimitOverrides, principal: Principal, clientIp: string): ServiceDeps {
  primary = new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: leaseOutput() } });
  const container = createContainer({
    db: h.t.db,
    storage: () => h.storage,
    llm: () => ({ primary, secondary: new FakeLlmClient({ modelUsed: "fake-secondary", defaultResponse: { data: leaseOutput() } }) }),
    localStorageSigningSecret: () => "cache-charge-signing-secret-0123456789",
    primaryModelId: TEST_MODEL_ID,
    rateLimits,
  });
  return container.forRequest(principal, true, clientIp);
}

async function leaseBytes(suffix = ""): Promise<Uint8Array> {
  return new TextEncoder().encode((await readFile(path.join(FIXTURES_DIR, "leave_and_license.txt"), "utf8")) + suffix);
}

// The attacker spends its one allowed call on novel text, then submits the candidate text.
async function attackerOutcome(limits: RateLimitOverrides, victimAnalyzedFirst: boolean) {
  if (victimAnalyzedFirst) {
    const victim = depsFor({ ...GENEROUS, ...limits }, guestB, VICTIM_IP);
    await analyze(victim, guestB, await h.uploadBytes(guestB, "lease.txt", MIME.txt, await leaseBytes()));
  }
  const attacker = depsFor({ ...GENEROUS, ...limits }, guestA, ATTACKER_IP);
  await analyze(attacker, guestA, await h.uploadBytes(guestA, "burn.txt", MIME.txt, await leaseBytes("\nProbe mutation one.\n")));
  const callsBeforeCandidate = primary.callCount;
  const candidate = await analyze(attacker, guestA, await h.uploadBytes(guestA, "candidate.txt", MIME.txt, await leaseBytes())).then(
    () => "served",
    (error: unknown) => (error instanceof DocumentAnalysisError ? error.code : String(error)),
  );
  return { candidate, providerCallsForCandidate: primary.callCount - callsBeforeCandidate };
}

describe("analysis cache — a hit is charged to every tier a model call is", () => {
  it.each<[string, RateLimitOverrides]>([
    ["principal per minute", { principalPerMinute: 1 }],
    ["principal per day", { principalPerDay: 1 }],
    ["client IP per minute", { ipLlmPerMinute: 1 }],
    ["client IP per day", { ipLlmPerDay: 1 }],
  ])("an attacker at its %s limit gets RATE_LIMITED whether or not someone else analyzed the text", async (_, limits) => {
    const victimFirst = await attackerOutcome(limits, true);
    await h.close();
    h = await createHarness();
    const nobodyFirst = await attackerOutcome(limits, false);

    expect(victimFirst).toEqual({ candidate: "RATE_LIMITED", providerCallsForCandidate: 0 });
    expect(nobodyFirst).toEqual({ candidate: "RATE_LIMITED", providerCallsForCandidate: 0 });
  });

  it("positive control: under its limits a caller is served the cached analysis with no provider call, charged once on each tier", async () => {
    await analyze(depsFor(GENEROUS, guestB, VICTIM_IP), guestB, await h.uploadBytes(guestB, "lease.txt", MIME.txt, await leaseBytes()));
    const buckets = async () => {
      const principal = await h.t.client.query<{ n: number }>("SELECT coalesce(sum(request_count), 0)::int AS n FROM rate_limit_buckets");
      const ip = await h.t.client.query<{ n: number }>("SELECT coalesce(sum(request_count), 0)::int AS n FROM ip_rate_limit_buckets");
      return { principal: principal.rows[0].n, ip: ip.rows[0].n };
    };
    const before = await buckets();
    const attacker = depsFor(GENEROUS, guestA, ATTACKER_IP);

    const result = await analyze(attacker, guestA, await h.uploadBytes(guestA, "lease.txt", MIME.txt, await leaseBytes()));

    expect(result.analysisState).toBe("complete");
    expect(primary.callCount).toBe(0);
    // Principal per minute and per day; client IP per minute and per day.
    expect(await buckets()).toEqual({ principal: before.principal + 2, ip: before.ip + 2 });
  });

  it("deps with no way to charge never read the cache: the model is called instead", async () => {
    await analyze(depsFor(GENEROUS, guestB, VICTIM_IP), guestB, await h.uploadBytes(guestB, "lease.txt", MIME.txt, await leaseBytes()));
    const llm = new FakeLlmClient({ modelUsed: TEST_MODEL_ID, defaultResponse: { data: leaseOutput() } });
    const uncharged = { ...h.deps(llm), chargeLlmCall: undefined };

    const result = await analyze(uncharged, guestA, await h.uploadBytes(guestA, "lease.txt", MIME.txt, await leaseBytes()));

    expect(result.analysisState).toBe("complete");
    expect(llm.callCount).toBe(1);
  });
});
