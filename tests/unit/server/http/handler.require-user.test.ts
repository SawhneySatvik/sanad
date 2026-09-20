// route()'s requireUser: a guest is refused with the same 400 VALIDATION_FAILED the user-only
// services throw, before a byte of the body is pulled — so a guest can't make POST /api/threads
// buffer its 16 MiB cap. A signed-in user's body is read as usual.

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import * as projectsRoute from "@/app/api/projects/route";
import * as threadsRoute from "@/app/api/threads/route";
import { route, type RouteHandler } from "@/server/http/handler";
import {
  callRoute,
  createRouteHarness,
  guestCookie,
  mintedCookie,
  userA,
  type RouteHarness,
} from "@tests/integration/routes/harness";

const REFUSED = { error: { code: "VALIDATION_FAILED", message: "The request could not be validated." } };

let h: RouteHarness;
let spies: MockInstance[] = [];
afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  await h.close();
});

function silenceLogs(): void {
  spies = (["error", "warn"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
}

// A POST whose JSON body is a stream that counts how many chunks were pulled from it. Well under
// every cap, with no Content-Length, so only an actual read can reach it. highWaterMark 0: the
// stream pulls only when read, never ahead to fill its queue.
function countingPost(path: string, json: unknown, cookie?: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const counter = { pulls: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        counter.pulls++;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  const req = new Request(new URL(path, "http://localhost"), { method: "POST", headers, body, duplex: "half" } as RequestInit);
  return { req, counter };
}

async function call(handler: RouteHandler, path: string, json: unknown, cookie?: string) {
  const { req, counter } = countingPost(path, json, cookie);
  const res = await callRoute(handler, req);
  return { res, req, counter };
}

describe("requireUser: true", () => {
  const Echo = z.object({ value: z.string() });

  it("refuses a guest with the typed 400 before the body is read; run never starts", async () => {
    h = await createRouteHarness();
    silenceLogs();
    let runs = 0;
    const handler = route({
      requireUser: true,
      usesLlm: false,
      body: z.object({ s: z.string() }),
      response: Echo,
      run: async () => ({ value: `run ${++runs}` }),
    });

    const { res, req, counter } = await call(handler, "/api/test", { s: "x" }, guestCookie().cookie);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(REFUSED);
    expect(counter.pulls).toBe(0);
    expect(req.bodyUsed).toBe(false);
    expect(runs).toBe(0);
  });

  it("still mints a session for a cookie-less caller, exactly as the service's own refusal did", async () => {
    h = await createRouteHarness();
    silenceLogs();

    const { res, counter } = await call(threadsRoute.POST, "/api/threads", { title: "t" });

    expect(res.status).toBe(400);
    expect(counter.pulls).toBe(0);
    expect(mintedCookie(res)).not.toBeNull();
  });

  it("the real user-only routes: POST /api/threads and POST /api/projects refuse a guest unread", async () => {
    h = await createRouteHarness();
    silenceLogs();
    const { cookie } = guestCookie();

    for (const [handler, path, json] of [
      [threadsRoute.POST, "/api/threads", { title: "Guest thread" }],
      [projectsRoute.POST, "/api/projects", { name: "Guest project" }],
    ] as const) {
      const { res, req, counter } = await call(handler, path, json, cookie);
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual(REFUSED);
      expect(counter.pulls, path).toBe(0);
      expect(req.bodyUsed, path).toBe(false);
    }
    expect((await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM threads")).rows[0].n).toBe(0);
    expect((await h.t.client.query<{ n: number }>("SELECT count(*)::int AS n FROM projects")).rows[0].n).toBe(0);
  });

  it("a signed-in user's body is read and the route runs (positive control)", async () => {
    h = await createRouteHarness();
    h.signIn(userA);

    const thread = await call(threadsRoute.POST, "/api/threads", { title: "Mine" });
    const project = await call(projectsRoute.POST, "/api/projects", { name: "Mine" });

    expect([thread.res.status, project.res.status]).toEqual([200, 200]);
    expect([thread.counter.pulls, project.counter.pulls]).toEqual([1, 1]);
    expect(thread.req.bodyUsed).toBe(true);
  });
});
