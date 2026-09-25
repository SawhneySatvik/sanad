// The fake provider: a small HTTP server standing in for both the Gemini Developer API and the
// OpenAI-compatible NIM/OpenRouter endpoints, at the exact transport boundary providers.ts's e2e
// redirect points at. Scripted by prompt-fingerprint match, with hold-and-release for mid-stream
// assertions, and a "down" toggle for the canary. Every request it receives is logged, whether or
// not it matched a script.

import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** One scripted answer: chunks are sent one at a time on a streaming request, joined on a non-streaming one. */
export interface FakeScript {
  id: string;
  /** A substring match against the request's extracted prompt text (system + user content, concatenated). */
  match: string;
  /** Each chunk is raw provider "token" text — concatenated, it must be the full valid JSON the caller's schema expects. */
  chunks: string[];
  /** 1-based count of chunks to send before holding (a streaming request only); omitted means never hold. */
  holdAfterChunk?: number;
}

/** One logged request, whether or not it matched a script. */
export interface LoggedRequest {
  requestId: string;
  receivedAt: string;
  path: string;
  kind: "gemini" | "openai-compatible" | "unknown";
  streaming: boolean;
  promptExcerpt: string;
  matchedScriptId: string | null;
  held: boolean;
}

export interface FakeProviderHandle {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const CONTROL_PREFIX = "/__control__";
// A held stream auto-releases after this long even if the test forgets to call release — a spec bug
// must time the spec out with a clear log line, never hang the whole run indefinitely.
const HOLD_SAFETY_TIMEOUT_MS = 25_000;

function jsonBody(res: http.ServerResponse, status: number, body: unknown): void {
  rawJsonBody(res, status, JSON.stringify(body));
}

// geminiChunkBody/openAiChunkBody below already return serialized JSON text (a provider's own wire
// format) — writing that through jsonBody() would JSON.stringify it a second time, turning the body
// into a quoted string the real @google/genai/openai SDKs cannot parse as the response they expect.
function rawJsonBody(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Extracts the prompt text a script's `match` is tested against, from either provider's request
// shape — the exact field names both adapters actually send (gemini.ts's `buildParts`, gemma.ts's
// `buildSystemPrompt`/`buildUserContent`).
function extractPromptText(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const record = body as Record<string, unknown>;

  // Gemini Developer API shape: { contents: [{ parts: [{ text }] }], systemInstruction?: { parts } }
  if (Array.isArray(record.contents)) {
    const fromContents = record.contents
      .flatMap((c) => (c && typeof c === "object" && Array.isArray((c as Record<string, unknown>).parts) ? (c as { parts: unknown[] }).parts : []))
      .map((p) => (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string" ? (p as { text: string }).text : ""))
      .join("\n");
    const systemInstruction = record.systemInstruction;
    const fromSystem =
      systemInstruction && typeof systemInstruction === "object" && Array.isArray((systemInstruction as Record<string, unknown>).parts)
        ? (systemInstruction as { parts: { text?: string }[] }).parts.map((p) => p.text ?? "").join("\n")
        : "";
    return `${fromSystem}\n${fromContents}`;
  }

  // OpenAI-compatible shape: { messages: [{ role, content }] }
  if (Array.isArray(record.messages)) {
    return record.messages
      .map((m) => (m && typeof m === "object" && typeof (m as Record<string, unknown>).content === "string" ? (m as { content: string }).content : ""))
      .join("\n");
  }

  return "";
}

function isStreamingRequest(pathname: string, body: unknown): boolean {
  if (pathname.includes(":streamGenerateContent")) return true;
  if (typeof body === "object" && body !== null && (body as Record<string, unknown>).stream === true) return true;
  return false;
}

function requestKind(pathname: string, body: unknown): LoggedRequest["kind"] {
  if (pathname.includes(":generateContent") || pathname.includes(":streamGenerateContent")) return "gemini";
  if (typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).messages)) return "openai-compatible";
  return "unknown";
}

function geminiChunkBody(text: string): string {
  return JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
}

function openAiChunkBody(text: string, streaming: boolean): string {
  if (streaming) {
    return JSON.stringify({
      id: "fake-chunk",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake-gemma",
      choices: [{ index: 0, delta: { content: text } }],
    });
  }
  return JSON.stringify({
    id: "fake-completion",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake-gemma",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** Starts the fake provider on `port` (0 for an ephemeral port). See the module header for its contract. */
export async function startFakeProvider(port = 0): Promise<FakeProviderHandle> {
  const scripts = new Map<string, FakeScript>();
  const requests: LoggedRequest[] = [];
  const holds = new Map<string, { release: () => void }>();
  let down = false;

  function handleControl(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (pathname === `${CONTROL_PREFIX}/health` && req.method === "GET") {
      jsonBody(res, 200, { ok: true });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/reset` && req.method === "POST") {
      scripts.clear();
      requests.length = 0;
      for (const hold of holds.values()) hold.release();
      holds.clear();
      down = false;
      jsonBody(res, 200, { ok: true });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/down` && req.method === "POST") {
      down = true;
      jsonBody(res, 200, { ok: true });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/up` && req.method === "POST") {
      down = false;
      jsonBody(res, 200, { ok: true });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/scripts` && req.method === "POST") {
      readJsonBody(req).then((body) => {
        const script = body as FakeScript;
        scripts.set(script.id, script);
        jsonBody(res, 200, { ok: true });
      });
      return;
    }
    if (pathname === `${CONTROL_PREFIX}/requests` && req.method === "GET") {
      jsonBody(res, 200, { requests });
      return;
    }
    if (pathname.startsWith(`${CONTROL_PREFIX}/release/`) && req.method === "POST") {
      const requestId = pathname.slice(`${CONTROL_PREFIX}/release/`.length);
      const hold = holds.get(requestId);
      if (hold) {
        hold.release();
        holds.delete(requestId);
        jsonBody(res, 200, { released: true });
      } else {
        jsonBody(res, 404, { released: false, reason: "no such hold (already released, or never held)" });
      }
      return;
    }
    jsonBody(res, 404, { error: `fake-provider: unknown control endpoint ${pathname}` });
  }

  async function handleProvider(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    if (down) {
      // Simulates total outage: no response at all, not even a clean HTTP error — the exact shape
      // of connection-refused/reset a real fetch sees when nothing is listening or answering.
      req.socket.destroy();
      return;
    }

    const body = await readJsonBody(req);
    const streaming = isStreamingRequest(pathname, body);
    const promptText = extractPromptText(body);
    const kind = requestKind(pathname, body);
    const requestId = randomUUID();
    const matched = [...scripts.values()].find((s) => promptText.includes(s.match));

    const logEntry: LoggedRequest = {
      requestId,
      receivedAt: new Date().toISOString(),
      path: pathname,
      kind,
      streaming,
      promptExcerpt: promptText.slice(0, 200),
      matchedScriptId: matched?.id ?? null,
      held: false,
    };
    requests.push(logEntry);

    if (!matched) {
      jsonBody(res, 500, { error: `fake-provider: no script matched this request's prompt`, promptExcerpt: logEntry.promptExcerpt });
      return;
    }

    const encodeChunk = (text: string) => (kind === "gemini" ? geminiChunkBody(text) : openAiChunkBody(text, streaming));

    if (!streaming) {
      rawJsonBody(res, 200, encodeChunk(matched.chunks.join("")));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (let i = 0; i < matched.chunks.length; i++) {
      res.write(`data: ${encodeChunk(matched.chunks[i])}\n\n`);
      if (matched.holdAfterChunk === i + 1) {
        logEntry.held = true;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            holds.delete(requestId);
            logEntry.held = false;
            resolve();
          }, HOLD_SAFETY_TIMEOUT_MS);
          holds.set(requestId, {
            release: () => {
              clearTimeout(timer);
              logEntry.held = false;
              resolve();
            },
          });
        });
      }
    }
    if (kind === "openai-compatible") res.write("data: [DONE]\n\n");
    res.end();
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith(CONTROL_PREFIX)) {
      handleControl(req, res, pathname);
      return;
    }
    handleProvider(req, res, pathname).catch((error: unknown) => {
      jsonBody(res, 500, { error: `fake-provider: internal error handling ${pathname}: ${String(error)}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: boundPort } = server.address() as AddressInfo;

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const hold of holds.values()) hold.release();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
