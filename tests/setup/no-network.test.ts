import http from "node:http";
import https, { request as httpsRequestNamed } from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { LiveNetworkCallError } from "./live-network-call-error";
import { acknowledgeViolations } from "./no-network";

// TEST-NET-1 (RFC 5737) — reserved for documentation, guaranteed non-routable on the public
// internet. Used instead of a real domain so an unblocked call here can only ever fail or hang,
// never quietly 200.
const NON_LOCAL_HOST = "192.0.2.1";

describe("network guard (tests/setup/no-network.ts)", () => {
  it("rejects a fetch() to a non-local host with LiveNetworkCallError", async () => {
    await expect(fetch(`https://${NON_LOCAL_HOST}`)).rejects.toBeInstanceOf(LiveNetworkCallError);
    expect(acknowledgeViolations()).toHaveLength(1);
  });

  it("rejects a fetch() to a non-local host given as a URL object", async () => {
    await expect(fetch(new URL(`https://${NON_LOCAL_HOST}/path`))).rejects.toBeInstanceOf(
      LiveNetworkCallError,
    );
    expect(acknowledgeViolations()).toHaveLength(1);
  });

  it("fails CLOSED on a fetch input that can't be parsed as a URL", async () => {
    // Not a string, not a URL, not a Request — real fetch would eventually
    // reject too, but with its own TypeError, not ours; the old
    // implementation let this fall through to the real fetch untouched.
    const unparseable = { toString: () => "not a url" } as unknown as RequestInfo;
    await expect(fetch(unparseable)).rejects.toBeInstanceOf(LiveNetworkCallError);
    expect(acknowledgeViolations()).toHaveLength(1);
  });

  it("throws LiveNetworkCallError from https.request to a non-local host", () => {
    expect(() => https.request(`https://${NON_LOCAL_HOST}`)).toThrow(LiveNetworkCallError);
    expect(acknowledgeViolations()).toHaveLength(1);
  });

  it("throws LiveNetworkCallError from http.get to a non-local host", () => {
    expect(() => http.get(`http://${NON_LOCAL_HOST}`)).toThrow(LiveNetworkCallError);
    expect(acknowledgeViolations()).toHaveLength(1);
  });

  it("throws LiveNetworkCallError from http.request given an options object host", () => {
    expect(() => http.request({ host: NON_LOCAL_HOST, port: 80, path: "/" })).toThrow(
      LiveNetworkCallError,
    );
    expect(acknowledgeViolations()).toHaveLength(1);
  });

  it("guards a named ESM import too (syncBuiltinESMExports closed this route)", () => {
    expect(() => httpsRequestNamed(`https://${NON_LOCAL_HOST}`)).toThrow(LiveNetworkCallError);
    expect(acknowledgeViolations()).toHaveLength(1);
  });

  describe("(url, options) merge precedence — mirrors node:http's own Object.assign exactly", () => {
    it("an explicit options.hostname overrides a LOCAL url's host — still blocked", () => {
      expect(() => http.request("http://127.0.0.1/", { hostname: NON_LOCAL_HOST })).toThrow(
        LiveNetworkCallError,
      );
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("an explicit options.host does NOT shadow a NON-LOCAL url's hostname — still blocked (the exact escape case)", () => {
      // urlToHttpOptions sets ONLY `hostname` from the URL, never `host` — so Node actually dials
      // the URL's real host regardless of options.host. A guard keyed on
      // `secondHostname ?? firstHostname` would conflate the two distinct option keys and miss this.
      expect(() => http.request(`http://${NON_LOCAL_HOST}/`, { host: "localhost" })).toThrow(
        LiveNetworkCallError,
      );
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("positive control: options.host does not override a LOCAL url either — never blocked", () => {
      // Same asymmetry, opposite direction: proves the guard isn't just
      // "block anything with a non-local string anywhere in the args."
      expect(() => {
        const req = http.request("http://127.0.0.1/", { host: NON_LOCAL_HOST, port: 1 });
        req.on("error", () => {}); // no real listener on port 1 — an expected, different error
        req.destroy();
      }).not.toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(0);
    });
  });

  describe("IPv6 normalization", () => {
    it("treats bracketed [::1] as local — never blocked", () => {
      expect(() => {
        const req = http.request({ host: "[::1]", port: 1, path: "/" });
        req.on("error", () => {});
        req.destroy();
      }).not.toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(0);
    });

    it("treats the unspecified address :: as local — never blocked", () => {
      expect(() => {
        const req = http.request({ host: "::", port: 1, path: "/" });
        req.on("error", () => {});
        req.destroy();
      }).not.toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(0);
    });
  });

  describe("secret env vars", () => {
    it("deletes every provider/DB secret from process.env", () => {
      for (const name of [
        "GEMINI_API_KEY",
        "NVIDIA_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "DATABASE_URL",
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
        "KV_REST_API_URL",
        "KV_REST_API_TOKEN",
      ]) {
        expect(process.env[name]).toBeUndefined();
      }
    });
  });

  describe("egress beyond fetch/http", () => {
    it("throws LiveNetworkCallError from the global WebSocket constructor, synchronously", () => {
      expect(() => new WebSocket(`wss://${NON_LOCAL_HOST}/`)).toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("throws LiveNetworkCallError from http2.connect", () => {
      expect(() => http2.connect(`https://${NON_LOCAL_HOST}`)).toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("throws LiveNetworkCallError from net.connect", () => {
      expect(() => net.connect(80, NON_LOCAL_HOST)).toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("throws LiveNetworkCallError from net.connect given an options object", () => {
      expect(() => net.connect({ host: NON_LOCAL_HOST, port: 80 })).toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("throws LiveNetworkCallError from tls.connect (the postgres driver's transport)", () => {
      expect(() => tls.connect({ host: NON_LOCAL_HOST, port: 443 })).toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("throws LiveNetworkCallError from new http.ClientRequest (bypasses http.request)", () => {
      expect(() => new http.ClientRequest({ host: NON_LOCAL_HOST, port: 80, path: "/" })).toThrow(
        LiveNetworkCallError,
      );
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("does not block tls.connect to localhost (fails later for a different, expected reason)", () => {
      expect(() => {
        const socket = tls.connect({ host: "127.0.0.1", port: 1, rejectUnauthorized: false });
        socket.on("error", () => {}); // nothing listens on port 1 — expected, not our guard
        socket.destroy();
      }).not.toThrow(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(0);
    });

    it("does not block http2.connect to localhost", () => {
      let session: http2.ClientHttp2Session | undefined;
      expect(() => {
        session = http2.connect("https://127.0.0.1:1");
        session.on("error", () => {});
      }).not.toThrow(LiveNetworkCallError);
      session?.destroy();
      expect(acknowledgeViolations()).toHaveLength(0);
    });
  });

  describe("fetch redirects", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/to-non-local") {
          res.writeHead(302, { location: `https://${NON_LOCAL_HOST}/evil` });
          res.end();
          return;
        }
        if (req.url === "/to-local-target") {
          res.writeHead(302, { location: "/final" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("final");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("blocks a redirect from a local server to a non-local Location", async () => {
      await expect(fetch(`${baseUrl}/to-non-local`)).rejects.toBeInstanceOf(LiveNetworkCallError);
      expect(acknowledgeViolations()).toHaveLength(1);
    });

    it("positive control: a local-to-local redirect is still followed transparently", async () => {
      const res = await fetch(`${baseUrl}/to-local-target`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("final");
      expect(acknowledgeViolations()).toHaveLength(0);
    });
  });

  describe("violation self-check", () => {
    // `it.fails` inverts the usual pass/fail meaning: this wrapped test is expected to fail. It
    // swallows the guard's error on purpose (mirrors an SDK's own catch-and-retry shape) — without
    // the module-level afterEach hook, it would pass cleanly, which is exactly the bug being caught.
    it.fails(
      "a caught-and-swallowed guarded call still fails the test, even with no assertion on it",
      async () => {
        try {
          await fetch(`https://${NON_LOCAL_HOST}`);
        } catch {
          // swallowed on purpose — no rethrow, no acknowledgeViolations()
        }
      },
    );
  });

  describe("positive control — localhost traffic is never blocked", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    });

    it("allows fetch() to localhost", async () => {
      const res = await fetch(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(acknowledgeViolations()).toHaveLength(0);
    });

    it("allows http.get to localhost", async () => {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.get(baseUrl, (res) => resolve(res.statusCode));
        req.on("error", reject);
      });
      expect(status).toBe(200);
      expect(acknowledgeViolations()).toHaveLength(0);
    });

    it("allows net.connect to a local TCP server (full round trip)", async () => {
      const echoServer = net.createServer((socket) => {
        socket.end("hello");
      });
      await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
      const { port } = echoServer.address() as AddressInfo;

      const received = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {});
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      expect(received).toBe("hello");
      expect(acknowledgeViolations()).toHaveLength(0);

      await new Promise<void>((resolve, reject) =>
        echoServer.close((err) => (err ? reject(err) : resolve())),
      );
    });
  });

  // Empirical proof the guard doesn't break PGlite (a WASM-embedded Postgres
  // with no network I/O) — every data-layer test depends on this.
  it("does not interfere with PGlite (embedded, no network I/O)", async () => {
    const db = new PGlite();
    try {
      const result = await db.query<{ answer: number }>("select 1 as answer");
      expect(result.rows).toEqual([{ answer: 1 }]);
    } finally {
      await db.close();
    }
    expect(acknowledgeViolations()).toHaveLength(0);
  });
});
