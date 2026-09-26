"use client";

/**
 * `/compare/[id]`'s own client orchestrator — page.tsx stays a thin server shell that only awaits
 * `params`; every fetch happens here. Fetches the comparison plus both sides' text, hoisted here
 * (not inside CompareDetail) so both texts load even on the phone layout, where only one
 * DocumentViewer is mounted at a time.
 */

import { useEffect, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/feedback/error-state";
import { ApiError } from "@/lib/api";
import { useDocumentTextQuery } from "@/components/workspace/document/use-document-text-query";
import { PageHeader } from "@/components/page/page-header";
import { useComparisonQuery } from "./use-comparison-query";
import { CompareDetail } from "./compare-detail";

export interface CompareViewProps {
  comparisonId: string;
}

function CompareSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export function CompareView({ comparisonId }: CompareViewProps) {
  const comparisonQuery = useComparisonQuery(comparisonId);
  const documentAId = comparisonQuery.data?.documentAId;
  const documentBId = comparisonQuery.data?.documentBId;
  const textAQuery = useDocumentTextQuery(documentAId ?? "", Boolean(documentAId));
  const textBQuery = useDocumentTextQuery(documentBId ?? "", Boolean(documentBId));

  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Route-entry focus only, once per mount — matches the analysis workspace's own convention.
    headingRef.current?.focus();
  }, []);

  if (comparisonQuery.isLoading) return <CompareSkeleton />;

  if (comparisonQuery.isError) {
    const code = comparisonQuery.error instanceof ApiError ? comparisonQuery.error.code : "INTERNAL_ERROR";
    const retryAfterSeconds = comparisonQuery.error instanceof ApiError ? comparisonQuery.error.retryAfterSeconds : undefined;
    return (
      <div className="p-6">
        <ErrorState code={code} retryAfterSeconds={retryAfterSeconds} onRetry={() => comparisonQuery.refetch()} />
      </div>
    );
  }

  const comparison = comparisonQuery.data;
  if (!comparison) return null; // unreachable: isLoading/isError above cover every other status

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader ref={headingRef} tabIndex={-1} title={comparison.title} containerClassName="px-6 pt-6" />
      {textAQuery.isError || textBQuery.isError ? (
        <div className="p-6">
          <ErrorState
            code={textAQuery.error instanceof ApiError ? textAQuery.error.code : textBQuery.error instanceof ApiError ? textBQuery.error.code : "INTERNAL_ERROR"}
            onRetry={() => {
              void textAQuery.refetch();
              void textBQuery.refetch();
            }}
          />
        </div>
      ) : !textAQuery.data || !textBQuery.data ? (
        <CompareSkeleton />
      ) : (
        <CompareDetail comparison={comparison} textA={textAQuery.data} textB={textBQuery.data} />
      )}
    </div>
  );
}
