// Timing half of verify-batch's oracle gate: how long POST /api/verify-batch takes must not say
// whether a cited document is another principal's, missing, malformed, unextracted or expired —
// nor tell any of those apart from the caller's own document genuinely lacking the quote.

import { randomUUID } from "node:crypto";
import { loadavg } from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as verifyBatchRoute from "@/app/api/verify-batch/route";
import * as schema from "@/db/schema";
import type { Principal } from "@/server/core/types";
import { verifyMany } from "@/server/deterministic/verify";
import { pendingDocument, readyDocument } from "@tests/support/data/documents";
import { MIN_RESPONSE_MS } from "@/server/services/verify-batch";
import { callRoute, createRouteHarness, guestCookie, request, type RouteHarness } from "./harness";

// Large enough that real verify() work is well above measurement noise — on a 3k-char fixture, an
// unequalized foreign lookup and an owned-absent verify are both ~1 ms, so a green result there
// would prove nothing.
const DOC_CHARS = 100_000;
const ROUNDS = 15;
// Every variant's median must sit within this many ms of owned-absent's. Measured with 15 samples a
// variant, the largest observed gap was ~10 ms under heavy concurrent load (average 25-34). 20 ms
// is ~2× that, so a not-owned path leaking ~40 ms is still caught reliably.
const MAX_MEDIAN_GAP_MS = 20;
const QUOTES = Array.from(
  { length: 20 },
  (_, i) => `The employee shall be entitled to ${i + 3} days of paid leave and a relocation allowance payable in advance`,
);

let seed = 20260923;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
}
const WORDS = (
  "the tenant landlord licensee licensor shall pay rent deposit month notice terminate agreement premises " +
  "clause lease period days written consent sublet maintenance repairs electricity charges penalty interest " +
  "default breach party parties hereto whereas refundable deduction damages arbitration jurisdiction"
).split(" ");
function legalProse(chars: number): string {
  let out = "";
  for (let clause = 1; out.length < chars; clause++) {
    const words = Array.from({ length: 8 + Math.floor(random() * 25) }, () => WORDS[Math.floor(random() * WORDS.length)]);
    out += `${clause}. ${words.join(" ")}. `;
  }
  return out.slice(0, chars);
}

let h: RouteHarness;
let cookie: string;
let ownedText: string;
const variants: { name: string; documentId: string }[] = [];

beforeAll(async () => {
  h = await createRouteHarness();
  const caller = guestCookie();
  cookie = caller.cookie;
  const me: Principal = { type: "guest", guestSessionId: caller.guestSessionId };
  const other: Principal = { type: "guest", guestSessionId: guestCookie().guestSessionId };

  const owned = await readyDocument(h.t, me, legalProse(DOC_CHARS));
  ownedText = owned.canonicalText ?? "";
  const foreign = await readyDocument(h.t, other, legalProse(DOC_CHARS));
  const pending = await pendingDocument(h.t, me);
  const expired = await readyDocument(h.t, me, legalProse(DOC_CHARS));
  await h.t.db.update(schema.documents).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.documents.id, expired.id));

  variants.push(
    { name: "owned, quotes absent", documentId: owned.id },
    { name: "another guest's", documentId: foreign.id },
    { name: "missing uuid", documentId: randomUUID() },
    { name: "malformed id", documentId: "not-a-uuid" },
    { name: "owned, pending", documentId: pending.id },
    { name: "owned, expired", documentId: expired.id },
  );
});
afterAll(async () => {
  await h.close();
});

async function timeOne(documentId: string): Promise<number> {
  const citations = QUOTES.map((quote) => ({ documentId, quote }));
  const started = performance.now();
  const res = await callRoute(verifyBatchRoute.POST, request("POST", "/api/verify-batch", { cookie, json: { citations } }));
  const body = await res.json();
  const elapsed = performance.now() - started;
  expect(res.status).toBe(200);
  expect(body.results.every((r: { status: string }) => r.status === "not_found")).toBe(true);
  return elapsed;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("POST /api/verify-batch latency does not depend on whether the caller can use the document", () => {
  it(
    "owned-absent, foreign, missing, malformed, pending and expired medians are indistinguishable",
    async () => {
      // The work the floor has to cover: verify() of this quote set against the owned document.
      const workStarted = performance.now();
      expect(verifyMany(QUOTES, ownedText, "text").every((r) => r.status === "not_found")).toBe(true);
      const ownedVerifyMs = performance.now() - workStarted;

      // Samples are interleaved (rotating order each round) so machine load hits every variant
      // alike; medians are then checked both on an absolute gap and on a ratio band, so a
      // short-circuiting not-owned path fails either way it could leak.
      const samples = new Map(variants.map((v) => [v.name, [] as number[]]));
      await timeOne(variants[0].documentId); // warm-up, discarded
      for (let round = 0; round < ROUNDS; round++) {
        for (let k = 0; k < variants.length; k++) {
          const variant = variants[(round + k) % variants.length];
          samples.get(variant.name)?.push(await timeOne(variant.documentId));
        }
      }

      const rows = variants.map(({ name }) => {
        const values = samples.get(name) ?? [];
        return { name, median: median(values), min: Math.min(...values), max: Math.max(...values) };
      });
      const owned = rows[0].median;
      console.log(
        [
          `verify-batch timing: ${QUOTES.length} absent quotes, ${DOC_CHARS}-char documents, ${ROUNDS} interleaved rounds, ` +
            `MIN_RESPONSE_MS ${MIN_RESPONSE_MS}, owned verify() work ${ownedVerifyMs.toFixed(1)} ms, load avg ${loadavg().map((l) => l.toFixed(2)).join(" ")}`,
          ...rows.map(
            (r) =>
              `  ${r.name.padEnd(22)} median ${r.median.toFixed(1)} ms  (min ${r.min.toFixed(1)}, max ${r.max.toFixed(1)})  ` +
              `median − owned-absent median ${(r.median - owned).toFixed(1)} ms`,
          ),
        ].join("\n"),
      );

      for (const row of rows.slice(1)) {
        expect(Math.abs(row.median - owned), `${row.name} vs owned-absent, ms`).toBeLessThan(MAX_MEDIAN_GAP_MS);
        expect(row.median / owned, `${row.name} vs owned-absent`).toBeGreaterThan(0.8);
        expect(row.median / owned, `${row.name} vs owned-absent`).toBeLessThan(1.25);
      }
      expect(owned).toBeGreaterThanOrEqual(MIN_RESPONSE_MS);
    },
    120_000,
  );
});
