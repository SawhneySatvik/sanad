// A stream is a mid-stream outcome or nothing at all — never silently "still going" forever, and
// never a frame trusted without its own schema. Fakes sit only at the transport boundary (global
// fetch), never at postSse/consumeAskStream themselves (CLAUDE.md's mocking policy).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAskConversation } from "@/components/workspace/ask/use-ask-conversation";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

function sseResponse(frames: string[], options: { close?: boolean } = { close: true }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (options.close !== false) controller.close();
      // else: deliberately left open — the caller controls when (if ever) it continues.
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAskConversation — a stream always resolves to a real, terminal status", () => {
  it("a stream that ends with neither `final` nor `error` resolves to status 'error', never stuck on 'streaming'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(['event: token\ndata: {"type":"token","text":"Thinking"}\n\n'])),
    );

    const { result } = renderHook(() => useAskConversation(DOCUMENT_ID));
    act(() => result.current.send("what is the notice period"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toBeTruthy();
    expect(result.current.streamingText).toBeNull();
  });

  it("a `final` frame whose message fails schema validation resolves to status 'error', with no turn appended for it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(['event: final\ndata: {"type":"final","message":{"garbage":true}}\n\n'])),
    );

    const { result } = renderHook(() => useAskConversation(DOCUMENT_ID));
    act(() => result.current.send("what is the notice period"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    // Exactly the one user turn send() appended — the malformed final never became a second, assistant turn.
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].role).toBe("user");
  });
});

describe("useAskConversation — send() can't orphan an in-flight turn", () => {
  it("calling send() again while the first turn is still streaming is a no-op: one fetch, one user turn", async () => {
    const fetchSpy = vi.fn(async () => sseResponse(['event: token\ndata: {"type":"token","text":"Still thinking"}\n\n'], { close: false }));
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useAskConversation(DOCUMENT_ID));
    act(() => result.current.send("first question"));
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    act(() => result.current.send("second question, sent too soon"));

    // Still exactly one user turn, one fetch — the second send() never ran.
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].content).toBe("first question");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
