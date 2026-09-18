import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@tests/support/db";
import { clientIpFromHeaders, normalizeIp, UNKNOWN_CLIENT_IP } from "@/server/rate-limit/client-ip";
import { checkIpLimit } from "@/server/rate-limit/limiter";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeIp — five-variant collapse regression", () => {
  it("v4 and its IPv4-mapped-v6 dotted-quad form collapse to the same normalized value", () => {
    const a = normalizeIp("203.0.113.9");
    const b = normalizeIp("::ffff:203.0.113.9");
    expect(a).toEqual({ ok: true, value: "203.0.113.9" });
    expect(a).toEqual(b);
  });

  it("v4-mapped-v6 detected after expansion, not just the dotted-quad textual form: the all-hex spelling of the same address also collapses", () => {
    // 203.0.113.9 == 0xcb, 0x00, 0x71, 0x09 -> groups cb00:7109.
    const hexForm = normalizeIp("::ffff:cb00:7109");
    const plainV4 = normalizeIp("203.0.113.9");
    expect(hexForm).toEqual({ ok: true, value: "203.0.113.9" });
    expect(hexForm).toEqual(plainV4);
  });

  it("two v6 addresses in the same /64 collapse to the same value, regardless of compression/case", () => {
    const a = normalizeIp("2001:db8::1");
    const b = normalizeIp("2001:DB8:0:0:0:0:0:1");
    expect(a.ok).toBe(true);
    expect(a).toEqual(b);
  });

  it("two v6 addresses in DIFFERENT /64s produce different values", () => {
    const a = normalizeIp("2001:db8::1");
    const b = normalizeIp("2001:db8:0:1::1");
    expect(a.ok && b.ok).toBe(true);
    expect(a).not.toEqual(b);
  });

  it("a comma-separated multi-valued header value is NOT itself a valid IP (that's clientIpFromHeaders's job to split, not normalizeIp's)", () => {
    expect(normalizeIp("203.0.113.9, 10.0.0.1")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a non-IP string", () => {
    expect(normalizeIp("not-an-ip")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects an empty/whitespace-only string as missing, not invalid", () => {
    expect(normalizeIp("")).toEqual({ ok: false, reason: "missing" });
    expect(normalizeIp("   ")).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects an out-of-range v4 octet", () => {
    expect(normalizeIp("999.999.999.999")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("normalizeIp — idempotence (the output is itself always a valid, re-normalizable IP)", () => {
  const variants = [
    "203.0.113.9",
    "::ffff:203.0.113.9",
    "::ffff:cb00:7109",
    "2001:db8::1",
    "2001:DB8:0:0:0:0:0:1",
    "2001:db8:0:1::1",
    "::1",
    "fe80::1",
  ];

  it.each(variants)("normalizeIp(normalizeIp(%s).value) === normalizeIp(%s)", (raw) => {
    const first = normalizeIp(raw);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = normalizeIp(first.value);
    expect(second).toEqual(first);
  });
});

class FakeHeaders {
  constructor(private readonly values: Record<string, string>) {}
  get(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.values, name.toLowerCase()) ? this.values[name.toLowerCase()] : null;
  }
}

describe("clientIpFromHeaders — trusted-header policy", () => {
  it("on Vercel, trusts x-vercel-forwarded-for", () => {
    vi.stubEnv("VERCEL", "1");
    const headers = new FakeHeaders({ "x-vercel-forwarded-for": "203.0.113.9" });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: true, value: "203.0.113.9" });
  });

  it("on Vercel, a present-but-untrusted x-forwarded-for with NO x-vercel-forwarded-for is REJECTED, not silently trusted (red-proves the spoof case)", () => {
    vi.stubEnv("VERCEL", "1");
    const headers = new FakeHeaders({ "x-forwarded-for": "203.0.113.9" });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: false, reason: "missing" });
  });

  it("on Vercel, TRUSTED_PROXY_HOPS does not make x-forwarded-for trusted", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const headers = new FakeHeaders({ "x-forwarded-for": "203.0.113.9" });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: false, reason: "missing" });
  });

  it("on Vercel, x-vercel-forwarded-for wins even when x-forwarded-for is ALSO present (never blended/compared)", () => {
    vi.stubEnv("VERCEL", "1");
    const headers = new FakeHeaders({
      "x-vercel-forwarded-for": "203.0.113.9",
      "x-forwarded-for": "198.51.100.1",
    });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: true, value: "203.0.113.9" });
  });

  it("off Vercel with no TRUSTED_PROXY_HOPS, x-forwarded-for is ignored: a client can write it", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    const headers = new FakeHeaders({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: false, reason: "missing" });
  });

  it("off Vercel, x-vercel-forwarded-for is ignored even with TRUSTED_PROXY_HOPS set: only Vercel's edge can vouch for it", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(clientIpFromHeaders(new FakeHeaders({ "x-vercel-forwarded-for": "203.0.113.9" }))).toEqual({ ok: false, reason: "missing" });
    expect(
      clientIpFromHeaders(new FakeHeaders({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "198.51.100.1" })),
    ).toEqual({ ok: true, value: "198.51.100.1" });
  });

  it("TRUSTED_PROXY_HOPS=1: the rightmost entry, the address the proxy itself saw — never an entry the client prepended", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const headers = new FakeHeaders({ "x-forwarded-for": "1.2.3.4, 5.6.7.8,  203.0.113.9 " });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: true, value: "203.0.113.9" });
  });

  it("TRUSTED_PROXY_HOPS=2: the second entry from the right (the outer proxy appended the client, the inner one the outer proxy)", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    const headers = new FakeHeaders({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 10.0.0.2" });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: true, value: "203.0.113.9" });
  });

  it("fewer entries than TRUSTED_PROXY_HOPS: missing — the request didn't come through every proxy", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIpFromHeaders(new FakeHeaders({ "x-forwarded-for": "203.0.113.9" }))).toEqual({ ok: false, reason: "missing" });
    expect(clientIpFromHeaders(new FakeHeaders({}))).toEqual({ ok: false, reason: "missing" });
  });

  it.each(["0", "-1", "yes", "true", "1.5", "1e1", "0x1"])("TRUSTED_PROXY_HOPS=%j is not a hop count: x-forwarded-for stays untrusted", (bad) => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", bad);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(clientIpFromHeaders(new FakeHeaders({ "x-forwarded-for": "203.0.113.9" }))).toEqual({ ok: false, reason: "missing" });
    vi.restoreAllMocks();
  });

  it("warns about a bad TRUSTED_PROXY_HOPS at most once per process", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "yes");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fresh = await import("@/server/rate-limit/client-ip");

    for (let i = 0; i < 3; i++) fresh.clientIpFromHeaders(new FakeHeaders({ "x-forwarded-for": "203.0.113.9" }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("TRUSTED_PROXY_HOPS");
    warn.mockRestore();
  });

  it("a multi-valued Vercel header's FIRST entry is used and trimmed", () => {
    vi.stubEnv("VERCEL", "1");
    const headers = new FakeHeaders({ "x-vercel-forwarded-for": "  203.0.113.9  , 10.0.0.1, 172.16.0.1" });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: true, value: "203.0.113.9" });
  });

  it("neither header present -> missing", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIpFromHeaders(new FakeHeaders({}))).toEqual({ ok: false, reason: "missing" });
  });

  it("an empty-string header value is treated as absent, not as an empty IP", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIpFromHeaders(new FakeHeaders({ "x-vercel-forwarded-for": "" }))).toEqual({ ok: false, reason: "missing" });
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(clientIpFromHeaders(new FakeHeaders({ "x-forwarded-for": "" }))).toEqual({ ok: false, reason: "missing" });
  });

  it("a malformed value in the trusted header normalizes to invalid, not missing", () => {
    vi.stubEnv("VERCEL", "1");
    const headers = new FakeHeaders({ "x-vercel-forwarded-for": "not-an-ip" });
    expect(clientIpFromHeaders(headers)).toEqual({ ok: false, reason: "invalid" });
  });
});

// End to end through the IP tier: what the header policy above means for buckets.
describe("clientIpFromHeaders -> checkIpLimit — spoofed headers buy no fresh bucket", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    vi.stubEnv("RATE_LIMIT_IP_HASH_SECRET", "a".repeat(32));
  });
  afterEach(async () => {
    await t.close();
  });

  async function bucketsFor(headerSets: Record<string, string>[]): Promise<number[]> {
    const clock = { now: () => new Date("2026-09-23T10:00:30.000Z") };
    for (const headers of headerSets) {
      const ip = clientIpFromHeaders(new FakeHeaders(headers));
      await checkIpLimit(t.db, ip.ok ? ip.value : UNKNOWN_CLIENT_IP, { limit: 100, clock });
    }
    const rows = await t.client.query<{ request_count: number }>("SELECT request_count FROM ip_rate_limit_buckets ORDER BY request_count");
    return rows.rows.map((row) => row.request_count);
  }

  const spoofed = ["198.51.100.1", "198.51.100.2", "198.51.100.3"].map((ip) => ({ "x-forwarded-for": ip, "x-vercel-forwarded-for": ip }));

  it("off Vercel, no TRUSTED_PROXY_HOPS: three requests spoofing three different IPs share ONE bucket", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    expect(await bucketsFor(spoofed)).toEqual([3]);
  });

  it("TRUSTED_PROXY_HOPS=1: a client prepending spoofed entries still lands in its own real bucket", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const viaProxy = ["198.51.100.1", "198.51.100.2", "198.51.100.3"].map((fake) => ({ "x-forwarded-for": `${fake}, 203.0.113.50` }));
    expect(await bucketsFor(viaProxy)).toEqual([3]);
  });

  it("positive control: TRUSTED_PROXY_HOPS=1 and three genuinely different proxy-seen clients get three buckets", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(await bucketsFor(spoofed)).toEqual([1, 1, 1]);
  });
});

describe("UNKNOWN_CLIENT_IP", () => {
  it("is not itself a syntactically valid IP (never collides with a real normalized bucket key)", () => {
    expect(normalizeIp(UNKNOWN_CLIENT_IP)).toEqual({ ok: false, reason: "invalid" });
  });
});
