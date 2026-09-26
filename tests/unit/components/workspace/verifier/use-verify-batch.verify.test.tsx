/**
 * Channel 8 (the One Guarantee's UI half): useVerifyBatch never renders a status the server didn't
 * return, and never lets a badge sit beside text that wasn't itself the text just checked. Every
 * fetch is faked at the transport boundary (global fetch), never at apiFetch/apiFetchJson — per the
 * repo's "fakes only at the SDK/transport boundary" convention.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { useVerifyBatch } from "@/components/workspace/verifier/use-verify-batch";
import type { VerificationOutput } from "@/shared/contracts/common";

const DOC_ID = "doc-1";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function wrapper({ children }: { children: ReactNode }) {
  return <LiveRegionProvider>{children}</LiveRegionProvider>;
}

function verificationResult(overrides: Partial<VerificationOutput> = {}): VerificationOutput {
  return { status: "verified", spanStart: 0, spanEnd: 4, spanText: "rent", verifierVersion: "v1", textHash: "hash", ...overrides } as VerificationOutput;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useVerifyBatch — status always comes from the server response, never client-derived", () => {
  it("(a) text that IS an exact substring of the document still shows 'approximate' when that's what the server returned — the hook never re-derives verified from the text alone", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { results: [verificationResult({ status: "approximate", claimedQuote: "rent is due" })] }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useVerifyBatch(DOC_ID, "rent is due"), { wrapper });

    await waitFor(() => expect(result.current.lastChecked?.result.status).toBe("approximate"), { timeout: 2000 });
    expect(result.current.lastChecked?.text).toBe("rent is due");
    // The request body carried exactly the field's own text — the hook never substitutes anything.
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.citations).toEqual([{ documentId: DOC_ID, quote: "rent is due" }]);
  });

  it("(b) editing after a result clears the badge immediately (phase leaves 'result') even before the debounced check lands", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { results: [verificationResult()] })));

    const { result } = renderHook(() => useVerifyBatch(DOC_ID, "rent"), { wrapper });
    await waitFor(() => expect(result.current.phase).toBe("result"));

    act(() => result.current.setText("rent is"));
    expect(result.current.phase).toBe("checking");
  });

  it("(b) on a 500 the field reverts to the last checked text — a badge is never shown beside text that was never itself checked", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [verificationResult({ spanText: "rent" })] }))
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useVerifyBatch(DOC_ID, "rent"), { wrapper });
    await waitFor(() => expect(result.current.phase).toBe("result"));
    expect(result.current.lastChecked?.text).toBe("rent");

    act(() => result.current.setText("rent is due NOW"));
    await waitFor(() => expect(result.current.phase).toBe("error"));

    // The field's own text was reverted to match the pair that's actually safe to show together.
    expect(result.current.text).toBe(result.current.lastChecked?.text);
    expect(result.current.text).toBe("rent");
  });

  it("(c) a stale, slower response for since-edited text is discarded — only the latest edit's result ever renders", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    let resolveFirst!: (value: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(200, { results: [verificationResult({ status: "verified", spanText: "SECOND" })] })));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useVerifyBatch(DOC_ID, "first text"), { wrapper });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => result.current.setText("second text"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.phase).toBe("result"));
    expect(result.current.lastChecked?.result.spanText).toBe("SECOND");

    // The first (now-stale) request finally resolves — it must never overwrite the second's result.
    resolveFirst(jsonResponse(200, { results: [verificationResult({ status: "not_found", spanText: null, claimedQuote: "first text" })] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.lastChecked?.result.spanText).toBe("SECOND");
  });

  it("caps the request at VERIFY_BATCH_MAX_QUOTE_CHARS client-side before ever calling fetch", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useVerifyBatch(DOC_ID, "short"), { wrapper });
    await new Promise((r) => setTimeout(r, 10));
    fetchSpy.mockClear();

    act(() => result.current.setText("x".repeat(4001)));
    expect(result.current.phase).toBe("too-long");
    await new Promise((r) => setTimeout(r, 700));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("(d) hitting the soft cap shows an honest throttled message with no stale badge, keeps the typed text as-is, and auto-retries once the rolling window frees up", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    // A fresh Response per call — a Response body can only be read once, and this request fires 21 times.
    const fetchSpy = vi.fn(async () => jsonResponse(200, { results: [verificationResult()] }));
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = renderHook(() => useVerifyBatch(DOC_ID, "seed"), { wrapper });

    // The seeded check is request #1; 19 more edits (each waiting out its own 600ms debounce) bring
    // the rolling window to exactly the 20-request soft cap, all still real successful checks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.phase).toBe("result");

    for (let i = 0; i < 19; i++) {
      act(() => result.current.setText(`edit ${i}`));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(20);

    // The 21st attempt trips the cap: no request goes out, the field keeps exactly what was typed
    // (never reverted — no server ever disagreed with it), and no badge renders beside it.
    act(() => result.current.setText("one too many"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(20);
    expect(result.current.phase).toBe("throttled");
    expect(result.current.errorMessage).toMatch(/too many checks/i);
    expect(result.current.text).toBe("one too many");

    // Once the oldest request in the rolling window ages out, the armed retry fires on its own —
    // "reschedule," not merely "wait for the next edit."
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(21);
    expect(result.current.phase).toBe("result");
    expect(result.current.lastChecked?.text).toBe("one too many");
  });
});
