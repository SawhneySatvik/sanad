/**
 * The three upload-flow network calls. The two POSTs (createUploadTarget, confirmAnalyze) and the
 * retry POST go straight through src/lib/api's apiFetchJson, which throws ApiError (documentId
 * included) for every non-2xx response — the same error shape every other client-side call in this
 * app throws. putRelay alone stays hand-rolled: it's an XMLHttpRequest PUT, not a fetch(), for the
 * real upload-progress event fetch has no equivalent for — but its own non-2xx/offline handling
 * still goes through errorFromParts/ApiError, never a second, duplicated parser.
 */

import { CreateUploadTargetInput, UploadTargetOutput } from "@/shared/contracts/uploads";
import { AnalyzeDocumentInput, AnalyzeDocumentOutput, DocumentWithFindingsOutput } from "@/shared/contracts/documents";
import { ApiError, apiFetchJson, errorFromParts, reportNetworkFailure } from "@/lib/api";
import { UPLOAD_INTERRUPTED_MESSAGE } from "./copy";

/** Every code this flow's error state can carry — UPLOAD_INTERRUPTED is local UI-only, never a
 * server code: canonicalErrorMessage has no row for it (constructing an ApiError with this code
 * would crash), so it is never routed through ApiError, only through UploadInterruptedError below. */
export type UploadFlowErrorCode = ApiError["code"] | "UPLOAD_INTERRUPTED";

/** Thrown only by putRelay's own xhr.onerror — a transport-level XHR failure that never reached an
 * HTTP status at all, so there is no ErrorBody to parse and no canonical per-code copy to look up. */
export class UploadInterruptedError extends Error {
  readonly code = "UPLOAD_INTERRUPTED" as const;
  constructor() {
    super(UPLOAD_INTERRUPTED_MESSAGE);
    this.name = "UploadInterruptedError";
  }
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function createUploadTarget(input: CreateUploadTargetInput): Promise<UploadTargetOutput> {
  return UploadTargetOutput.parse(await apiFetchJson("/api/uploads", { method: "POST", json: input }));
}

export async function confirmAnalyze(input: AnalyzeDocumentInput): Promise<AnalyzeDocumentOutput> {
  return AnalyzeDocumentOutput.parse(await apiFetchJson("/api/documents", { method: "POST", json: input }));
}

export async function retryAnalyze(documentId: string): Promise<DocumentWithFindingsOutput> {
  return DocumentWithFindingsOutput.parse(await apiFetchJson(`/api/documents/${documentId}/analyze`, { method: "POST" }));
}

export interface RelayTarget {
  method: "direct-put" | "server-relay";
  uploadUrl: string;
}

/**
 * PUTs the file's bytes to whatever `uploadUrl`/`method` POST /api/uploads returned — never a
 * hard-coded relay path (design's own hazard note). XMLHttpRequest, not fetch: fetch has no
 * upload-progress event.
 */
export function putRelay(target: RelayTarget, file: File, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isOffline()) {
      reject(new ApiError({ code: "OFFLINE" }));
      return;
    }
    // No withCredentials: a same-origin server-relay PUT sends cookies by default regardless, and
    // a direct-put signed URL is a different origin that never wants this app's cookies at all.
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.uploadUrl, true);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };

    xhr.onerror = () => {
      // A direct-put target is a different origin (the storage provider's own signed URL) — its
      // failure can be a storage-side/CORS problem, not our own connection dropping, so it must
      // never raise the app-wide offline banner. Only a server-relay failure (same-origin, our own
      // server unreachable) is a real connectivity signal.
      if (target.method === "server-relay") reportNetworkFailure();
      reject(new UploadInterruptedError());
    };

    xhr.onabort = () => reject(new DOMException("The upload was cancelled.", "AbortError"));

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      reject(errorFromParts(xhr.status, { get: (name: string) => xhr.getResponseHeader(name) }, xhr.responseText));
    };

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(file);
  });
}
