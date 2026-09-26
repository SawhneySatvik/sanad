"use client";

/**
 * The reopen re-verify pass — sequential, chunked verify-batch, never touching the badge until it
 * resolves. Runs once the local snapshot is available; its own setState calls all sit inside an
 * async continuation (after an await), never synchronously in the effect body. A chunk that fails
 * gets a real, working Retry: clicking it flips the chunk back to "pending" (so the button can't
 * double-fire) and reruns this exact same verify-batch call, reading the abort signal fresh at
 * click time rather than the one this effect captured when it first ran.
 */

import { useEffect, useState, type RefObject } from "react";
import { chunkForVerifyBatch, UNLINKED_SOURCE_DOCUMENT_ID } from "@/lib/guest-threads";
import type { GuestThread } from "@/lib/guest-thread-store";
import type { AskCitationOutput } from "@/shared/contracts/threads";
import { verifyBatch } from "./api";
import type { DisplayCitation } from "./types";

/** Shared with runTurn/handleSubmit's own catch blocks — a genuine unmount or superseded id swap is never a real failure to report. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

interface KeyedCitation {
  key: string;
  documentId: string;
  quote: string;
}

/**
 * Runs verify-batch for one chunk and turns the response straight into the overrides map a chunk's
 * citations resolve to — shared by both the reopen pass's first attempt and a failed citation's own
 * Retry, so a retry is a real verify() round trip against the live document, never a client-guessed
 * status. `onRetry` is only ever attached to the failure branch; a caller that reruns this same
 * function is exactly what makes Retry real rather than a dead button. Returns null for an aborted
 * request — a real unmount or a superseded id swap, nothing left to render.
 */
async function verifyChunk(
  chunk: KeyedCitation[],
  signal: AbortSignal | undefined,
  onRetry: () => void,
): Promise<Record<string, DisplayCitation> | null> {
  try {
    const results = await verifyBatch(
      chunk.map((entry) => ({ documentId: entry.documentId, quote: entry.quote })),
      signal,
    );
    const overrides: Record<string, DisplayCitation> = {};
    chunk.forEach((entry, i) => {
      const sourceDocumentId = entry.documentId === UNLINKED_SOURCE_DOCUMENT_ID ? null : entry.documentId;
      const citation: AskCitationOutput = { id: null, sourceDocumentId, inputMode: null, verification: results[i] };
      overrides[entry.key] = { kind: "resolved", citation };
    });
    return overrides;
  } catch (err) {
    if (isAbortError(err)) return null;
    const overrides: Record<string, DisplayCitation> = {};
    chunk.forEach((entry) => {
      overrides[entry.key] = { kind: "failed", sourceDocumentId: entry.documentId, preview: entry.quote, onRetry };
    });
    return overrides;
  }
}

export interface UseCitationReverify {
  citationOverrides: Record<string, DisplayCitation>;
  /** Clears every override — the pathname-reset effect's own concern, on a genuine navigation back to /chat. */
  reset: () => void;
}

/**
 * `thread` is the real dependency, not just its id: useLocalThreadSnapshot resolves in two passes
 * for hydration safety (a "loading" server snapshot, then the real one) — an effect keyed on the id
 * alone would capture the FIRST pass's null value in its closure and never re-run once the real
 * snapshot arrives, since the id itself never changes between the two passes. The snapshot's own
 * object identity is stable once loaded (cached per id), so this never re-runs on an unrelated
 * render. `abortControllerRef` is the screen's own single controller, passed by reference (never its
 * `.current` read once at call time) so a click on Retry always reads whichever controller is
 * current at that moment, not one captured when this effect first ran.
 */
export function useCitationReverify(thread: GuestThread | null, abortControllerRef: RefObject<AbortController | null>): UseCitationReverify {
  const [citationOverrides, setCitationOverrides] = useState<Record<string, DisplayCitation>>({});

  useEffect(() => {
    if (!thread) return;
    const keyed: KeyedCitation[] = [];
    thread.messages.forEach((message) => {
      message.citations.forEach((citation, citationIndex) => {
        keyed.push({ key: `${message.id}#${citationIndex}`, documentId: citation.sourceDocumentId, quote: citation.quoteText });
      });
    });
    if (keyed.length === 0) return;

    let cancelled = false;

    function retryChunk(chunk: KeyedCitation[]): void {
      setCitationOverrides((prev) => {
        const next = { ...prev };
        chunk.forEach((entry) => {
          next[entry.key] = { kind: "pending", sourceDocumentId: entry.documentId, preview: entry.quote };
        });
        return next;
      });
      void runChunk(chunk);
    }

    async function runChunk(chunk: KeyedCitation[]): Promise<void> {
      if (cancelled) return;
      const overrides = await verifyChunk(chunk, abortControllerRef.current?.signal, () => retryChunk(chunk));
      if (cancelled || overrides === null) return;
      setCitationOverrides((prev) => ({ ...prev, ...overrides }));
    }

    void (async () => {
      for (const chunk of chunkForVerifyBatch(keyed)) {
        if (cancelled) return;
        await runChunk(chunk);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [thread, abortControllerRef]);

  return { citationOverrides, reset: () => setCitationOverrides({}) };
}
