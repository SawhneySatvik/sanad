// The e2e transport redirect: only honoured when isE2eMode() is true, which core/env.ts itself never
// allows in production — proven here at the providers.ts seam, not just at env.ts's own unit level,
// so a future refactor that reads the flag differently here still gets caught.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/server/core/env";
import { tiersOf } from "@/server/llm/fallback";
import { createGeminiClient, createGemmaClient, createGoogleGemmaClient, e2eProvidersTestHooks } from "@/server/llm/providers";
import { z } from "zod";

afterEach(() => {
  vi.unstubAllEnvs();
  // The fetch-spy test below installs vi.spyOn(globalThis, "fetch") — restored here so it never
  // leaks into a later test in this file (which would otherwise silently intercept a later test's
  // real calls to its own local fake server).
  vi.restoreAllMocks();
});

const SCHEMA = z.object({ ok: z.literal(true) });

// A minimal Gemini-Developer-API-shaped body: the real SDK's GenerateContentResponse.text getter
// concatenates candidates[0].content.parts[*].text, so the model's "raw text" is that string.
function geminiBody(rawJson: string): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: rawJson }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  });
}

function openAiBody(rawJson: string): string {
  return JSON.stringify({ choices: [{ message: { content: rawJson } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
}

async function startFake(body: () => string): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the Gemini/Gemma-on-Gemini fetch redirect", () => {
  it("outside production, with SABOOT_E2E=1 and SABOOT_E2E_PROVIDER_URL set, complete() hits the fake instead of Google", async () => {
    const fake = await startFake(() => geminiBody(JSON.stringify({ ok: true })));
    try {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("SABOOT_E2E", "1");
      vi.stubEnv("SABOOT_E2E_PROVIDER_URL", fake.url);
      vi.stubEnv("GEMINI_API_KEY", "test-key");

      const client = tiersOf(createGeminiClient())[0].client;
      const result = await client.complete({ systemPrompt: "sys", userPrompt: "user", schema: SCHEMA });

      expect(result.data).toEqual({ ok: true });
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("outside production, the fallback model and Google-hosted Gemma tiers are redirected too (same fetch override)", async () => {
    const fake = await startFake(() => geminiBody(JSON.stringify({ ok: true })));
    try {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("SABOOT_E2E", "1");
      vi.stubEnv("SABOOT_E2E_PROVIDER_URL", fake.url);
      vi.stubEnv("GEMINI_API_KEY", "test-key");

      const tiers = tiersOf(createGeminiClient());
      await tiers[1].client.complete({ systemPrompt: "sys", userPrompt: "user", schema: SCHEMA });
      expect(fake.requests).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("production refuses to build the client at all when SABOOT_E2E=1 (isE2eMode()'s own guard)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_PROVIDER_URL", "http://127.0.0.1:1");
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    expect(() => createGeminiClient()).toThrow(ConfigError);
  });

  it("production with the URL var set but the flag unset builds a normal client, and never redirects it", () => {
    // isE2eMode() is the only gate e2eProviderBaseUrl() checks before reading
    // SABOOT_E2E_PROVIDER_URL at all — tests/unit/server/e2e-flags.test.ts already proves it is
    // false whenever SABOOT_E2E isn't exactly "1", production included, so there is no code path
    // left by which this env combination could reach the override. Building the client here must
    // not throw (unlike the flag=1-but-URL-unset case below): production's ordinary, unredirected
    // shape is what gets built.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "");
    vi.stubEnv("SABOOT_E2E_PROVIDER_URL", "http://127.0.0.1:1");
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    expect(() => createGeminiClient()).not.toThrow();
  });

  it("production with the URL var set but the flag unset: a real local server at that URL sees zero requests", async () => {
    // Proves the override is truly inert, not merely "didn't throw": points
    // SABOOT_E2E_PROVIDER_URL at a real, running local server and shows it is never contacted.
    // complete() is still exercised end-to-end — but through a fetch spy standing in for the SDK's
    // own default transport, never the real global fetch: a real attempt at the real Google host
    // would trip the guard installed by tests/setup/no-network.ts, whose one escape hatch only its
    // own paired test file may reach (see tests/architecture/network-guard-scope.test.ts).
    const localServer = await startFake(() => geminiBody(JSON.stringify({ ok: true })));
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("SABOOT_E2E", "");
      vi.stubEnv("SABOOT_E2E_PROVIDER_URL", localServer.url);
      vi.stubEnv("GEMINI_API_KEY", "test-key");

      // Installed before the client is built: the SDK may capture `fetch` at construction time.
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(geminiBody(JSON.stringify({ ok: true })), { status: 200 }));

      const client = tiersOf(createGeminiClient())[0].client;
      await client.complete({ systemPrompt: "sys", userPrompt: "user", schema: SCHEMA });

      expect(fetchSpy).toHaveBeenCalled();
      const [calledInput] = fetchSpy.mock.calls[0];
      const calledUrl = calledInput instanceof Request ? calledInput.url : String(calledInput);
      expect(calledUrl).toContain("generativelanguage.googleapis.com");
      expect(localServer.requests).toHaveLength(0);
    } finally {
      await localServer.close();
    }
  });

  it("rejects a non-loopback SABOOT_E2E_PROVIDER_URL — fail closed rather than silently using it", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_PROVIDER_URL", "https://example.com");
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    expect(() => createGeminiClient()).toThrow(/loopback/);
  });

  it.each([
    ["127.0.0.1.nip.io", "http://127.0.0.1.nip.io:4100"],
    ["localhost.example.com", "http://localhost.example.com:4100"],
  ])(
    "rejects a look-alike host (%s) — an exact loopback match, never a prefix/substring check",
    (_label, url) => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("SABOOT_E2E", "1");
      vi.stubEnv("SABOOT_E2E_PROVIDER_URL", url);
      vi.stubEnv("GEMINI_API_KEY", "test-key");

      expect(() => createGeminiClient()).toThrow(/loopback/);
    },
  );

  it("accepts the IPv6 loopback literal [::1] — new URL(...).hostname keeps its brackets", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_PROVIDER_URL", "http://[::1]:4100");
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    expect(() => createGeminiClient()).not.toThrow();
  });

  it("M1: SABOOT_E2E=1 outside production with SABOOT_E2E_PROVIDER_URL unset refuses to build — never falls back to an unredirected client", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_PROVIDER_URL", "");
    vi.stubEnv("GEMINI_API_KEY", "test-key");

    expect(() => createGeminiClient()).toThrow(/SABOOT_E2E_PROVIDER_URL must be set/);
    // Same refusal at the bare helper level, and for a Gemini-hosted Gemma client (the other
    // consumer of e2eProviderBaseUrl()'s fetch override).
    expect(() => e2eProvidersTestHooks.e2eProviderBaseUrl()).toThrow(/SABOOT_E2E_PROVIDER_URL must be set/);
    expect(() => createGoogleGemmaClient()).toThrow(/SABOOT_E2E_PROVIDER_URL must be set/);
  });

  it("M1: the injected fetch itself refuses (fails closed) any host but the real Gemini host, while in e2e mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SABOOT_E2E", "1");
    vi.stubEnv("SABOOT_E2E_PROVIDER_URL", "http://127.0.0.1:1");

    const redirectFetch = e2eProvidersTestHooks.e2eGeminiFetch("http://127.0.0.1:1");
    await expect(redirectFetch("https://not-google.example.com/x", undefined)).rejects.toThrow(/refusing to reach/);
    await expect(redirectFetch("https://evil.example.com/steal-a-key", undefined)).rejects.toThrow(/refusing to reach/);
  });
});

describe("the Gemma baseURL redirect (NIM and OpenRouter)", () => {
  it("outside production, each Gemma-side tier's baseURL is redirected to the fake, with its own path", async () => {
    const fake = await startFake(() => openAiBody(JSON.stringify({ ok: true })));
    try {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("SABOOT_E2E", "1");
      vi.stubEnv("SABOOT_E2E_PROVIDER_URL", fake.url);
      vi.stubEnv("GEMINI_API_KEY", "test-key");
      vi.stubEnv("NVIDIA_API_KEY", "test-key");
      vi.stubEnv("OPENROUTER_API_KEY", "test-key");

      const tiers = tiersOf(createGemmaClient());
      // [0] is Google-hosted Gemma (Gemini fetch redirect), [1] NIM, [2] OpenRouter.
      await tiers[1].client.complete({ systemPrompt: "sys", userPrompt: "user", schema: SCHEMA });
      await tiers[2].client.complete({ systemPrompt: "sys", userPrompt: "user", schema: SCHEMA });

      expect(fake.requests.some((r) => r.includes("/nim/v1/"))).toBe(true);
      expect(fake.requests.some((r) => r.includes("/openrouter/v1/"))).toBe(true);
    } finally {
      await fake.close();
    }
  });
});
