"use client";

/**
 * The one-shot sequential mutation: idle -> requesting-target -> uploading (determinate) ->
 * confirming (indeterminate) -> done, with error reachable from any network step, plus the client
 * pre-check gate before any request fires. Not a useQuery/useMutation — this is a one-shot flow, not
 * cached server state — component state fed by a hand-rolled async sequence, with the *final* result
 * pre-warming TanStack Query's cache once it lands.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { runClientPreChecks } from "./client-pre-checks";
import { createUploadTarget, confirmAnalyze, putRelay, retryAnalyze, UploadInterruptedError } from "./api";
import type { UploadCardError } from "./upload-error-card";
import type { AnalyzeDocumentOutput } from "@/shared/contracts/documents";

export type UploadFlowPhase = "idle" | "requesting-target" | "uploading" | "confirming" | "done" | "error";

export interface UploadFlowFileMeta {
  filename: string;
  sizeBytes: number;
}

export interface UseUploadFlowOptions {
  /** Called once success lands, with the new (or retried) document's id — never before that. */
  onUploaded: (documentId: string) => void;
}

export interface UseUploadFlowResult {
  phase: UploadFlowPhase;
  fileMeta: UploadFlowFileMeta | null;
  /** Real XMLHttpRequest.upload.onprogress value during "uploading" — meaningless in any other phase. */
  percent: number;
  error: UploadCardError | null;
  /** The composer's own disable signal — true for every network phase, false at idle/done/error. */
  busy: boolean;
  start: (file: File) => void;
  /** Only meaningful once error.documentId is set (a 502/503/504 after the document row already exists). */
  retry: () => void;
  /** Only valid during the determinate "uploading" phase — there is no cancel once confirm starts. */
  cancel: () => void;
  reset: () => void;
}

function toCardError(err: unknown): UploadCardError {
  if (err instanceof ApiError) {
    return {
      code: err.code,
      reason: err.reason,
      retryAfterSeconds: err.retryAfterSeconds,
      correlationId: err.correlationId,
      documentId: err.documentId,
    };
  }
  if (err instanceof UploadInterruptedError) {
    return { code: err.code };
  }
  return { code: "INTERNAL_ERROR" };
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export function useUploadFlow({ onUploaded }: UseUploadFlowOptions): UseUploadFlowResult {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<UploadFlowPhase>("idle");
  const [fileMeta, setFileMeta] = useState<UploadFlowFileMeta | null>(null);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<UploadCardError | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);

  // retry() has no AbortController of its own to cancel mid-flight (unlike start(), it's not
  // interruptible) — this is what stops its eventual resolution from calling onUploaded (which can
  // navigate) against a host that's already gone. Set true again on every mount, not just at
  // construction, so Strict Mode's dev-only mount/unmount/remount cycle never leaves a real,
  // currently-mounted instance permanently marked unmounted from its first, discarded pass.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function reset() {
    controller?.abort();
    setController(null);
    setPhase("idle");
    setFileMeta(null);
    setPercent(0);
    setError(null);
  }

  function cancel() {
    if (phase !== "uploading") return;
    controller?.abort();
  }

  function applySuccess(documentId: string, analyzeDocumentOutput: AnalyzeDocumentOutput) {
    queryClient.setQueryData(["documents", documentId], analyzeDocumentOutput);
    void queryClient.invalidateQueries({ queryKey: ["documents", "list"] });
    setPhase("done");
    onUploaded(documentId);
  }

  function start(file: File) {
    setFileMeta({ filename: file.name, sizeBytes: file.size });

    const preCheck = runClientPreChecks(file);
    if (!preCheck.ok) {
      setPhase("error");
      setError({ code: "CLIENT_REJECTED", reason: preCheck.reason });
      return;
    }

    setPhase("requesting-target");
    setPercent(0);
    setError(null);
    const abort = new AbortController();
    setController(abort);

    void (async () => {
      try {
        const target = await createUploadTarget({ filename: file.name, mimeType: preCheck.mimeType, sizeBytes: file.size });
        if (abort.signal.aborted) return;

        setPhase("uploading");
        await putRelay(target, file, (pct) => setPercent(pct), abort.signal);
        if (abort.signal.aborted) return;

        setPhase("confirming");
        const result = await confirmAnalyze({ storageRef: target.ref, filename: file.name, mimeType: preCheck.mimeType });
        if (abort.signal.aborted) return;
        applySuccess(result.document.id, result);
      } catch (err) {
        if (isAbort(err)) {
          setPhase("idle");
          return;
        }
        setPhase("error");
        setError(toCardError(err));
      }
    })();
  }

  function retry() {
    const documentId = error?.documentId;
    if (!documentId) return;

    setPhase("confirming");
    setError(null);

    void (async () => {
      try {
        const result = await retryAnalyze(documentId);
        if (!mountedRef.current) return;
        if (result.analysisState === "complete") {
          applySuccess(documentId, result);
          return;
        }
        // The row exists but analysis is still incomplete after a supposedly idempotent retry — a
        // server-side race, not any of the modelled network failures. Surfaced honestly rather than
        // silently treated as success.
        setPhase("error");
        setError({ code: "INTERNAL_ERROR", documentId });
      } catch (err) {
        if (!mountedRef.current) return;
        setPhase("error");
        setError(toCardError(err));
      }
    })();
  }

  return {
    phase,
    fileMeta,
    percent,
    error,
    busy: phase !== "idle" && phase !== "done" && phase !== "error",
    start,
    retry,
    cancel,
    reset,
  };
}
