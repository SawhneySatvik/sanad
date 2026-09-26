"use client";

/**
 * `/compare`'s picker: two slot cards, a swap control, the principal's own ready-or-not documents
 * (GET /api/documents, `items` — never a bare array), and a "Compare" submit. Never calls
 * the model itself; only the submit does. Deliberately scoped down for this build: no inline upload
 * affordance and no SignInNudge (cut for time — see the build report); a document is added to
 * Compare only via the list or the `?a=` deep link.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { EmptyState } from "@/components/feedback/empty-state";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { RetryAfterNotice } from "@/components/feedback/retry-after-notice";
import { PageHeader } from "@/components/page/page-header";
import { apiFetch, ApiError, useIsOffline } from "@/lib/api";
import { fetchDocument } from "@/components/workspace/document/use-document-query";
import { useCompareDocuments, type CompareDocumentListOutput } from "./use-compare-documents";
import { canCompare } from "./can-compare";
import {
  ADD_A_DOCUMENT_LABEL,
  CHOOSE_DOCUMENT_LABEL,
  COMPARE_ACTION_LABEL,
  COULD_NOT_BE_READ_NOTE,
  DEEP_LINK_FAILED_NOTICE,
  EMPTY_LIBRARY_HEADING,
  PICKER_BODY,
  PICKER_HEADING,
  REMOVE_LABEL,
  SLOT_A_LABEL,
  SLOT_B_LABEL,
  STILL_PROCESSING_NOTE,
  SWAP_LABEL,
  TRY_AGAIN_LABEL,
} from "../copy";

type DocumentRow = CompareDocumentListOutput["items"][number];
type Slot = { id: string; title: string; processingStatus: DocumentRow["processingStatus"] } | null;

function statusNote(status: DocumentRow["processingStatus"]): string | null {
  if (status === "pending") return STILL_PROCESSING_NOTE;
  if (status === "extraction_failed") return COULD_NOT_BE_READ_NOTE;
  return null;
}

function SlotCard({
  side,
  slot,
  onRemove,
}: {
  side: "A" | "B";
  slot: Slot;
  onRemove: () => void;
}) {
  const label = side === "A" ? SLOT_A_LABEL : SLOT_B_LABEL;
  const note = slot ? statusNote(slot.processingStatus) : null;
  return (
    <div aria-labelledby={`slot-${side}-label`} className="flex min-h-[96px] flex-1 flex-col justify-between gap-2 rounded-lg border border-dashed border-border p-3">
      <p id={`slot-${side}-label`} className="text-xs font-medium text-muted-foreground">
        {label}
      </p>
      {slot ? (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <div>
              <p className="text-sm font-medium text-foreground">{slot.title}</p>
              {note && <p className="text-xs text-muted-foreground">{note}</p>}
            </div>
          </div>
          <button
            type="button"
            aria-label={`${REMOVE_LABEL} ${label}`}
            onClick={onRemove}
            className="relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground before:absolute before:-inset-1 before:content-[''] hover:text-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{CHOOSE_DOCUMENT_LABEL}</p>
      )}
    </div>
  );
}

export function ComparePickerClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const isOffline = useIsOffline();

  const [slotA, setSlotA] = useState<Slot>(null);
  const [slotB, setSlotB] = useState<Slot>(null);
  const [deepLinkFailed, setDeepLinkFailed] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Captured once, before the clearing router.replace() below re-renders this route with no `a` —
  // a value re-read from searchParams after that replace would already be gone.
  const [initialA] = useState(() => searchParams.get("a"));

  const prefillQuery = useQuery({
    queryKey: ["documents", initialA] as const,
    queryFn: () => fetchDocument(initialA!),
    enabled: initialA !== null,
    retry: false,
  });

  // React's own "adjusting state during render" pattern (DocumentViewer's lastRenderedSeq uses the
  // same shape) — applying the settled fetch's result directly in the render body, guarded so it
  // fires at most once, rather than inside an effect (which would trigger cascading-render lint and
  // isn't needed: this isn't subscribing to an external system, it's a one-time derivation).
  const [prefillHandled, setPrefillHandled] = useState(false);
  if (initialA !== null && !prefillHandled) {
    if (prefillQuery.isSuccess) {
      setPrefillHandled(true);
      const { document } = prefillQuery.data;
      setSlotA({ id: document.id, title: document.title, processingStatus: document.processingStatus });
    } else if (prefillQuery.isError) {
      setPrefillHandled(true);
      setDeepLinkFailed(true);
    }
  }

  useEffect(() => {
    // The one genuine side effect here (a router call, not a state update) — clears the one-time
    // `?a=` seed from the URL once it's been applied, success or failure alike.
    if (prefillHandled) router.replace("/compare");
  }, [prefillHandled, router]);

  const documentsQuery = useCompareDocuments();
  const rows = useMemo(() => documentsQuery.data?.items ?? [], [documentsQuery.data]);

  function slotFor(id: string): "A" | "B" | null {
    if (slotA?.id === id) return "A";
    if (slotB?.id === id) return "B";
    return null;
  }

  function fillNextEmptySlot(row: DocumentRow) {
    const target: Slot = { id: row.id, title: row.title, processingStatus: row.processingStatus };
    if (slotA === null) setSlotA(target);
    else if (slotB === null && row.id !== slotA?.id) setSlotB(target);
  }

  function swap() {
    setSlotA(slotB);
    setSlotB(slotA);
  }

  async function handleCompare() {
    if (!canCompare(slotA?.id ?? null, slotB?.id ?? null) || isOffline) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await apiFetch("/api/comparisons", { method: "POST", json: { documentAId: slotA!.id, documentBId: slotB!.id } });
      const comparison = (await response.json()) as { id: string };
      await queryClient.invalidateQueries({ queryKey: ["comparisons"] });
      router.push(`/compare/${comparison.id}`);
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error : new ApiError({ code: "INTERNAL_ERROR" }));
      setSubmitting(false);
    }
  }

  // Zero documents: one empty state replaces the whole picker (both slot cards and Compare are
  // meaningless with nothing to fill them) rather than sitting under an already-disabled picker
  // no one can act on anyway.
  const noDocuments = documentsQuery.isSuccess && rows.length === 0;

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader title={PICKER_HEADING} description={PICKER_BODY} />

      {deepLinkFailed && <InlineNotice tone="warning">{DEEP_LINK_FAILED_NOTICE}</InlineNotice>}

      {noDocuments ? (
        <EmptyState heading={EMPTY_LIBRARY_HEADING} body={PICKER_BODY} action={{ label: ADD_A_DOCUMENT_LABEL, href: "/chat" }} />
      ) : (
        <>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <SlotCard side="A" slot={slotA} onRemove={() => setSlotA(null)} />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={SWAP_LABEL}
              onClick={swap}
              className="min-h-[44px] min-w-[44px] shrink-0 self-center"
            >
              <ArrowLeftRight aria-hidden="true" className="size-4" />
            </Button>
            <SlotCard side="B" slot={slotB} onRemove={() => setSlotB(null)} />
          </div>

          {submitError && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
              {submitError.code === "RATE_LIMITED" || submitError.code === "UPSTREAM_UNAVAILABLE" ? (
                <RetryAfterNotice kind={submitError.code} retryAfterSeconds={submitError.retryAfterSeconds} />
              ) : (
                <p className="text-sm text-foreground">
                  {submitError.code === "INVALID_DOCUMENT" && submitError.reason === "document_not_ready"
                    ? "This document isn't ready yet. Try again in a moment."
                    : submitError.message}
                </p>
              )}
              <div>
                <Button variant="outline" size="sm" onClick={handleCompare}>
                  {TRY_AGAIN_LABEL}
                </Button>
              </div>
            </div>
          )}

          <div>
            <Button
              type="button"
              onClick={handleCompare}
              disabled={!canCompare(slotA?.id ?? null, slotB?.id ?? null) || isOffline}
              aria-disabled={!canCompare(slotA?.id ?? null, slotB?.id ?? null) || isOffline}
            >
              {submitting ? `${COMPARE_ACTION_LABEL}…` : COMPARE_ACTION_LABEL}
            </Button>
          </div>

          {documentsQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : documentsQuery.isError ? (
            <ErrorState
              code={documentsQuery.error instanceof ApiError ? documentsQuery.error.code : "INTERNAL_ERROR"}
              retryAfterSeconds={documentsQuery.error instanceof ApiError ? documentsQuery.error.retryAfterSeconds : undefined}
              onRetry={() => documentsQuery.refetch()}
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map((row) => {
                const occupies = slotFor(row.id);
                const note = statusNote(row.processingStatus);
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      disabled={occupies !== null}
                      onClick={() => fillNextEmptySlot(row)}
                      className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border border-transparent px-2 py-2 text-left text-sm hover:border-border disabled:cursor-default"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium text-foreground">{row.title}</span>
                        {note && <span className="text-xs text-muted-foreground">{note}</span>}
                      </span>
                      {occupies && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{occupies}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
