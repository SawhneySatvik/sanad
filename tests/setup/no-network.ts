import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { afterEach } from "vitest";
import { LiveNetworkCallError } from "./live-network-call-error";

// Structural enforcement of the never-call-live-APIs rule: `npm test`/`npm run check-all` must
// never reach a live host, checked before every test body runs so no test can silently forget to
// fake the network boundary — see installNetworkGuard() below for exactly what's covered.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "::", "0.0.0.0"]);

function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(normalizeHostname(hostname));
}

// --- violation tracking: a guarded call throws into its own caller, but nothing forces that
// caller to propagate the error — an SDK that retries and rethrows a different error type could
// let a test that forgot its fake pass green anyway. Recorded before throwing; checked post-hoc.

const violations: LiveNetworkCallError[] = [];

function blockCall(message: string): never {
  const err = new LiveNetworkCallError(message);
  violations.push(err);
  throw err;
}

// A test that deliberately triggers the guard (`expect(() => ...).toThrow(LiveNetworkCallError)`)
// also "catches" the error internally, which looks identical to a swallowed one. This is the
// explicit signal that separates the two — call it after triggering the guard on purpose.
export function acknowledgeViolations(): LiveNetworkCallError[] {
  const acknowledged = violations.slice();
  violations.length = 0;
  return acknowledged;
}

function installViolationCheck(): void {
  afterEach(() => {
    if (violations.length === 0) return;
    const count = violations.length;
    const summary = violations.map((v) => v.message).join("\n---\n");
    violations.length = 0; // clear regardless of outcome — one bad test doesn't poison the next
    throw new Error(
      `${count} guarded network call(s) were blocked during this test but never acknowledged via ` +
        `acknowledgeViolations() — something swallowed the thrown LiveNetworkCallError before the ` +
        `test noticed (e.g. an SDK retry/catch path). The test still needs a fake at the SDK ` +
        `boundary. Blocked call(s):\n${summary}`,
    );
  });
}

// --- fetch -----------------------------------------------------------------

const NON_NETWORK_PROTOCOLS = new Set(["data:", "blob:"]);

function assertLocalUrl(rawUrl: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Fail CLOSED: an input real fetch/WebSocket can't even parse is blocked
    // here rather than handed to the real implementation, which might
    // coerce/interpret it in some SDK-specific way we can't predict.
    blockCall(`${label} — unparseable target "${rawUrl}"`);
    return;
  }
  if (NON_NETWORK_PROTOCOLS.has(parsed.protocol)) return; // never leaves the process
  if (!isLocalHostname(parsed.hostname)) {
    blockCall(`${label} to "${rawUrl}"`);
  }
}

function extractFetchUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return String(input);
}

let originalFetch: typeof fetch | undefined;

function installFetchGuard(): void {
  if (originalFetch) return; // idempotent
  originalFetch = globalThis.fetch.bind(globalThis);
  const captured = originalFetch;

  // Declared `async` deliberately: a throw inside becomes a REJECTED promise, not a synchronous
  // throw — this is what makes `expect(fetch(...)).rejects.toBeInstanceOf(...)` work, matching
  // real fetch's own promise-returning contract.
  const guarded: typeof fetch = async (input, init) => {
    const rawUrl = extractFetchUrl(input);
    assertLocalUrl(rawUrl, "fetch");

    const requestedRedirect = init?.redirect ?? "follow";
    // Force manual redirect handling so EVERY hop gets re-validated — a
    // local server redirecting to a non-local Location must not silently
    // sail through just because the *first* URL was local.
    const response = await captured(input, { ...init, redirect: "manual" });
    const isRedirect =
      response.status >= 300 && response.status < 400 && response.headers.has("location");
    if (!isRedirect) return response;

    const location = new URL(response.headers.get("location")!, rawUrl).href;
    assertLocalUrl(location, "fetch redirect");

    if (requestedRedirect === "manual") return response;
    if (requestedRedirect === "error") {
      throw new TypeError("Fetch redirect mode is 'error' but a redirect occurred");
    }
    // "follow" (default): re-enter `guarded` itself (not `captured`) so a
    // second/third/... hop is re-validated too, not just the first.
    return guarded(location, init);
  };
  globalThis.fetch = guarded;
}

// --- http / https / http2 / net / tls request-like functions --------------

interface MaybeHostOptions {
  hostname?: string;
  host?: string;
  socketPath?: string;
  path?: string;
}

function isHostOptionsLike(value: unknown): value is MaybeHostOptions {
  return typeof value === "object" && value !== null && !(value instanceof URL);
}

function safeUrlHostname(raw: string): string | undefined {
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}

// http.request/http.get overloads' precedence mirrors node:http's own merge: `urlToHttpOptions`
// sets ONLY `hostname` from the URL, never `host` — an explicit `options.host` never shadows a
// URL-derived hostname (get this backwards and a spoofed host slips past while Node dials the URL).
function resolveRequestHostname(args: unknown[]): string {
  const [first, second] = args;

  let urlDerivedHostname: string | undefined;
  let explicitOptions: unknown;

  if (typeof first === "string") {
    urlDerivedHostname = safeUrlHostname(first);
    explicitOptions = second;
  } else if (first instanceof URL) {
    urlDerivedHostname = first.hostname;
    explicitOptions = second;
  } else {
    explicitOptions = first; // options-only overload — first arg IS the options object
  }

  const merged: MaybeHostOptions = { hostname: urlDerivedHostname };
  if (isHostOptionsLike(explicitOptions)) {
    if (explicitOptions.hostname !== undefined) merged.hostname = explicitOptions.hostname;
    if (explicitOptions.host !== undefined) merged.host = explicitOptions.host;
    if (explicitOptions.socketPath !== undefined) merged.socketPath = explicitOptions.socketPath;
  }

  if (merged.socketPath) return "localhost"; // a unix socketPath never leaves the machine
  return merged.hostname || merged.host || "localhost";
}

// net.connect/tls.connect overloads: (options[, cb]), (port[, host][, cb]),
// (path[, cb]) — path form is IPC/unix socket, never network egress. Node
// defaults `host` to "localhost" when a port is given without one.
function resolveNetConnectHostname(args: unknown[]): string {
  const [first, second] = args;

  if (typeof first === "number") {
    return typeof second === "string" ? second : "localhost";
  }
  if (typeof first === "string") {
    return "localhost"; // IPC/unix socket path
  }
  if (isHostOptionsLike(first)) {
    if (typeof first.path === "string" || typeof first.socketPath === "string") return "localhost";
    return first.host ?? first.hostname ?? "localhost";
  }
  return "localhost";
}

function guardRequestHostname(hostname: string, label: string): void {
  if (!isLocalHostname(hostname)) {
    blockCall(`${label} to host "${hostname}"`);
  }
}

type AnyFn = (...args: unknown[]) => unknown;

// `http.get`/`https.get` do NOT call the exported `request` function internally — they close over
// the module's own local reference, so patching only `.request` leaves `.get` unguarded. Every
// entry point is wrapped explicitly, individually.
function wrapHostGuardedFn(
  original: AnyFn,
  label: string,
  resolveHostname: (args: unknown[]) => string,
): AnyFn {
  return (...args: unknown[]) => {
    guardRequestHostname(resolveHostname(args), label);
    return original(...args);
  };
}

function installHttpGuards(): void {
  http.request = wrapHostGuardedFn(
    http.request as AnyFn,
    "http.request",
    resolveRequestHostname,
  ) as typeof http.request;
  http.get = wrapHostGuardedFn(http.get as AnyFn, "http.get", resolveRequestHostname) as typeof http.get;
  https.request = wrapHostGuardedFn(
    https.request as AnyFn,
    "https.request",
    resolveRequestHostname,
  ) as typeof https.request;
  https.get = wrapHostGuardedFn(
    https.get as AnyFn,
    "https.get",
    resolveRequestHostname,
  ) as typeof https.get;
}

// `new http.ClientRequest(...)` bypasses `http.request` entirely — it's the
// class `http.request` itself instantiates internally, exported directly.
function installClientRequestGuard(): void {
  const OriginalClientRequest = http.ClientRequest;
  class GuardedClientRequest extends OriginalClientRequest {
    constructor(...args: ConstructorParameters<typeof OriginalClientRequest>) {
      guardRequestHostname(resolveRequestHostname(args), "new http.ClientRequest");
      super(...args);
    }
  }
  http.ClientRequest = GuardedClientRequest as unknown as typeof http.ClientRequest;
}

function installHttp2Guard(): void {
  const original = http2.connect;
  const guarded = (...args: Parameters<typeof http2.connect>): ReturnType<typeof http2.connect> => {
    const [authority] = args;
    const rawUrl = authority instanceof URL ? authority.href : String(authority);
    assertLocalUrl(rawUrl, "http2.connect");
    return original(...args);
  };
  http2.connect = guarded as typeof http2.connect;
}

// The postgres driver (prod path against Supabase) sits on `net`/`tls` —
// PGlite itself never touches either (pure WASM, no socket I/O), confirmed
// by the PGlite smoke test in no-network.test.ts.
function installNetTlsGuards(): void {
  net.connect = wrapHostGuardedFn(
    net.connect as AnyFn,
    "net.connect",
    resolveNetConnectHostname,
  ) as typeof net.connect;
  net.createConnection = wrapHostGuardedFn(
    net.createConnection as AnyFn,
    "net.createConnection",
    resolveNetConnectHostname,
  ) as typeof net.createConnection;
  tls.connect = wrapHostGuardedFn(
    tls.connect as AnyFn,
    "tls.connect",
    resolveNetConnectHostname,
  ) as typeof tls.connect;
}

// --- WebSocket ---------------------------------------------------------

function installWebSocketGuard(): void {
  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket !== "function") return; // not present in this runtime — nothing to guard

  class GuardedWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const rawUrl = url instanceof URL ? url.href : String(url);
      assertLocalUrl(rawUrl, "WebSocket");
      super(url, protocols);
    }
  }
  globalThis.WebSocket = GuardedWebSocket as unknown as typeof WebSocket;
}

// --- secrets ---------------------------------------------------------------

function deleteSecretEnvVars(): void {
  delete process.env.GEMINI_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  // @google/genai reads GOOGLE_API_KEY before GEMINI_API_KEY, and GOOGLE_GENAI_USE_VERTEXAI /
  // GOOGLE_APPLICATION_CREDENTIALS can route it to Vertex AI instead; OPENAI_API_KEY is read
  // implicitly by the `openai` package's default client construction — all deleted the same way.
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  delete process.env.DATABASE_URL;
}

// Covers fetch, http/https request()/get(), new http.ClientRequest, http2.connect, net/tls
// connect, and the global WebSocket constructor. NOT covered, deliberately: plain DNS lookups, a
// library using its own bundled transport instead of these built-ins, and worker_thread realms.
export function installNetworkGuard(): void {
  installFetchGuard();
  installHttpGuards();
  installClientRequestGuard();
  installHttp2Guard();
  installNetTlsGuards();
  installWebSocketGuard();
  // Without this, a named ESM import (`import { request } from "node:http"`) would still see the
  // ORIGINAL function — CJS property reassignment on a builtin's exports object doesn't propagate
  // to already-bound ESM bindings otherwise. Re-syncs every builtin touched above, not just http/https.
  syncBuiltinESMExports();
  deleteSecretEnvVars();
  installViolationCheck();
}

installNetworkGuard();
