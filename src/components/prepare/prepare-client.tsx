"use client";

/**
 * /documents/[id]/prepare's own client orchestrator — page.tsx fetches nothing server-side; every
 * byte here comes from client-side TanStack Query. GET-gated: a document whose analysisState isn't
 * "complete" never reaches POST …/prepare at all — generate() itself validates lensId before
 * checking analysis state, so a naive implementation would spend a 400 round-trip a not-yet-analysed
 * document was always going to hit. The GET response's own processingStatus is what this screen
 * renders instead.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { EmptyState } from "@/components/feedback/empty-state";
import { ScannedNotice } from "@/components/document/scanned-notice";
import { DisclaimerLine } from "@/components/brand/disclaimer-line";
import { ExportMenu } from "@/components/export";
import { useAnnounce, useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import { ApiError, useIsOffline } from "@/lib/api";
import { useDocumentQuery } from "@/components/workspace/document/use-document-query";
import type { FindingOutput } from "@/shared/contracts/documents";
import { usePrepareLens } from "./use-prepare-lens";
import { usePrepareQuery } from "./use-prepare-query";
import { PrepareLensSelect } from "./lens-select";
import { PrepareView } from "./prepare-view";
import { buildPrepareCopyText } from "./build-prepare-copy-text";
import {
  BACK_TO_DOCUMENT_LABEL,
  EXTRACTION_FAILED_BODY,
  EXTRACTION_FAILED_HEADING,
  GENERIC_DOCUMENT_NOTICE,
  GO_TO_DOCUMENT_LABEL,
  NOT_ANALYZED_BODY,
  NOT_ANALYZED_HEADING,
  PREPARE_READY_ANNOUNCEMENT,
  PREPARING_LABEL,
  TOO_LONG_TO_PREPARE_MESSAGE,
} from "./copy";
import "./print.css";

export interface PrepareClientProps {
  documentId: string;
  initialLensParam: string | null;
}

function PrepareSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// Mounts only while the Prepare call is in flight — a fresh instance per query key (the `key` prop
// below), so the loading announcement fires again on every genuinely new lens's own first fetch,
// never a second time for the same one.
function PreparingAnnouncement() {
  useAnnounceOnMount(PREPARING_LABEL, "polite");
  return null;
}

// Two calm, non-fabricated list-shaped placeholders — motion-safe: only, so a reduced-motion
// preference gets a static block instead of a pulse; Tailwind's own Skeleton has no such gate.
function PrepareLoadingBody() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{PREPARING_LABEL}</p>
      <div className="motion-safe:animate-pulse flex flex-col gap-3">
        <div className="h-24 rounded-lg bg-muted" />
        <div className="h-24 rounded-lg bg-muted" />
      </div>
      <div className="motion-safe:animate-pulse flex flex-col gap-3">
        <div className="h-16 rounded-lg bg-muted" />
        <div className="h-16 rounded-lg bg-muted" />
      </div>
    </div>
  );
}

export function PrepareClient({ documentId, initialLensParam }: PrepareClientProps) {
  const documentQuery = useDocumentQuery(documentId);

  if (documentQuery.isLoading) return <PrepareSkeleton />;

  if (documentQuery.isError) {
    const error = documentQuery.error;
    const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    const retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <ErrorState code={code} retryAfterSeconds={retryAfterSeconds} onRetry={() => documentQuery.refetch()} />
      </div>
    );
  }

  if (!documentQuery.data) return null; // unreachable: isLoading/isError above cover every other status

  return <PrepareReady key={documentId} documentId={documentId} initialLensParam={initialLensParam} data={documentQuery.data} />;
}

function PrepareReady({
  documentId,
  initialLensParam,
  data,
}: {
  documentId: string;
  initialLensParam: string | null;
  data: NonNullable<ReturnType<typeof useDocumentQuery>["data"]>;
}) {
  const router = useRouter();
  const announce = useAnnounce();
  const isOffline = useIsOffline();
  const { document } = data;
  const findings: FindingOutput[] = data.analysisState === "complete" ? data.findings : [];

  const lens = usePrepareLens(documentId, findings, document.documentType, initialLensParam);
  const prepareQuery = usePrepareQuery(documentId, lens.selectedLens, data.analysisState === "complete");

  const announcedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!prepareQuery.isSuccess) return;
    if (announcedRef.current === prepareQuery.dataUpdatedAt) return;
    announcedRef.current = prepareQuery.dataUpdatedAt;
    announce(PREPARE_READY_ANNOUNCEMENT, "polite");
  }, [prepareQuery.isSuccess, prepareQuery.dataUpdatedAt, announce]);

  const goToDocument = () => router.push(`/documents/${documentId}`);

  return (
    // A <div>, not a second <main>: AppShell's own SidebarInset is already the page's one main
    // landmark, and print.css's [data-prepare-print-root] selectors key off the attribute, not the tag.
    <div data-prepare-print-root className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <Link
        href={`/documents/${documentId}`}
        prefetch={false}
        className="print:hidden inline-flex w-fit min-h-11 items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" strokeWidth={1.75} />
        {BACK_TO_DOCUMENT_LABEL}
      </Link>

      {data.analysisState !== "complete" ? (
        document.processingStatus === "extraction_failed" ? (
          <EmptyState heading={EXTRACTION_FAILED_HEADING} body={EXTRACTION_FAILED_BODY} action={{ label: GO_TO_DOCUMENT_LABEL, onClick: goToDocument }} />
        ) : (
          <EmptyState heading={NOT_ANALYZED_HEADING} body={NOT_ANALYZED_BODY} action={{ label: GO_TO_DOCUMENT_LABEL, onClick: goToDocument }} />
        )
      ) : (
        <>
          <div className="print:hidden flex flex-wrap items-start justify-between gap-4">
            {lens.options.length > 0 && lens.selectedLens && (
              <PrepareLensSelect options={lens.options} value={lens.selectedLens} onChange={lens.setSelectedLens} disabled={isOffline || prepareQuery.isFetching} />
            )}
            {prepareQuery.data?.state === "complete" && (
              <ExportMenu
                exportText={prepareQuery.data.markdown}
                exportFilename="prepare.md"
                copyText={buildPrepareCopyText(prepareQuery.data, findings)}
                onPrint={() => window.print()}
              />
            )}
          </div>

          {document.inputMode === "native_document" && (
            <div className="print:hidden">
              <ScannedNotice inputMode="native_document" />
            </div>
          )}
          {document.documentType === "generic" && (
            <div className="print:hidden">
              <InlineNotice>{GENERIC_DOCUMENT_NOTICE}</InlineNotice>
            </div>
          )}

          {prepareQuery.isLoading && (
            <>
              <PreparingAnnouncement key={String(lens.selectedLens)} />
              <PrepareLoadingBody />
            </>
          )}

          {prepareQuery.isError && <PrepareErrorBody error={prepareQuery.error} onRetry={() => prepareQuery.refetch()} />}

          {prepareQuery.data && (
            <PrepareView
              prepare={prepareQuery.data}
              documentFindings={findings}
              onGoToDocument={goToDocument}
              extractionFailed={document.processingStatus === "extraction_failed"}
              generatedAt={new Date(prepareQuery.dataUpdatedAt)}
            />
          )}
        </>
      )}

      <div className="print:hidden">
        <DisclaimerLine variant="footer" />
      </div>
    </div>
  );
}

function PrepareErrorBody({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
  const retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
  const tooLong = code === "INVALID_DOCUMENT";

  return (
    <ErrorState
      code={code}
      retryAfterSeconds={retryAfterSeconds}
      serverMessage={tooLong ? TOO_LONG_TO_PREPARE_MESSAGE : undefined}
      onRetry={tooLong ? undefined : onRetry}
    />
  );
}
