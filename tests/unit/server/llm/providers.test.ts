import { afterEach, describe, expect, it, vi } from "vitest";
import { tiersOf } from "@/server/llm/fallback";
import { createGeminiClient, createGemmaClient } from "@/server/llm/providers";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createGeminiClient / createGemmaClient — rate-limit key wiring", () => {
  it("tags each Gemini-side tier with its own rate-limit key", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const tiers = tiersOf(createGeminiClient());
    expect(tiers.map((t) => t.rateLimitKey)).toEqual(["gemini", "gemini_fallback"]);
  });

  it("tags each Gemma-side tier with its own rate-limit key: Google Gemma separate, NIM and OpenRouter sharing one", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("NVIDIA_API_KEY", "test-key");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const tiers = tiersOf(createGemmaClient());
    expect(tiers.map((t) => t.rateLimitKey)).toEqual(["gemma_google", "gemma", "gemma"]);
  });
});
