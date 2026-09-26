"use client";

/**
 * /drafts/[id]'s own client orchestrator. A thin server page.tsx hands this component the resolved
 * :id; everything else — the draft itself, its revisions and the "Based on" secondary fetch — is
 * client-side TanStack Query, the same split every other route in this app already uses.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PencilLine } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/feedback/error-state";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { PageHeader } from "@/components/page/page-header";
import { RenameDialog } from "@/components/shell/rename-dialog";
import { ModelUsedNote } from "@/components/verification/model-used-note";
import { ExportMenu } from "@/components/export";
import { ApiError, useIsOffline } from "@/lib/api";
import { useAnnounce } from "@/components/layout-primitives/live-region";
import { DraftSection } from "./draft-section";
import { RevisionTimeline } from "./revision-timeline";
import { ReviseForm } from "./revise-form";
import { DraftErrorBanner } from "./draft-error-banner";
import { useDraftQuery } from "./queries/use-draft-query";
import { useDraftRevisionsQuery } from "./queries/use-draft-revisions-query";
import { useReviseDraftMutation } from "./queries/use-revise-draft-mutation";
import { useRenameDraftMutation } from "./queries/use-rename-draft-mutation";
import { useGroundingDocumentQuery } from "./queries/use-grounding-document-query";
import { basedOnLabel, GROUNDING_DOCUMENT_GONE_NOTICE, revisionLabel } from "./copy";
import "./print.css";

export interface DraftClientProps {
  draftId: string;
}

function DraftSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function DraftClient({ draftId }: DraftClientProps) {
  const draftQuery = useDraftQuery(draftId);

  if (draftQuery.isLoading) return <DraftSkeleton />;

  if (draftQuery.isError) {
    const error = draftQuery.error;
    const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    const retryAfterSeconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <ErrorState code={code} retryAfterSeconds={retryAfterSeconds} onRetry={() => draftQuery.refetch()} />
      </div>
    );
  }

  if (!draftQuery.data) return null; // unreachable: isLoading/isError above cover every other status

  return <DraftReady draft={draftQuery.data} draftId={draftId} />;
}

function DraftReady({ draft, draftId }: { draft: NonNullable<ReturnType<typeof useDraftQuery>["data"]>; draftId: string }) {
  const router = useRouter();
  const announce = useAnnounce();
  const isOffline = useIsOffline();
  const [renaming, setRenaming] = useState(false);

  const revisionsQuery = useDraftRevisionsQuery(draftId);
  const reviseMutation = useReviseDraftMutation(draftId);
  const renameMutation = useRenameDraftMutation(draftId);

  const groundedAndAvailable = draft.mode === "document_grounded" && draft.groundingDocumentAvailable === true;
  const basedOnQuery = useGroundingDocumentQuery(groundedAndAvailable ? draft.groundingDocumentId : null);
  const basedOnGone =
    draft.mode === "document_grounded" &&
    (draft.groundingDocumentAvailable === false ||
      (groundedAndAvailable && basedOnQuery.isError && basedOnQuery.error instanceof ApiError && basedOnQuery.error.code === "NOT_FOUND"));

  function handleRevise(userInstructions: string) {
    reviseMutation.mutate(
      { userInstructions },
      {
        onSuccess: (newDraft) => {
          announce("A new revision has been created.", "polite");
          router.push(`/drafts/${newDraft.id}`);
        },
      },
    );
  }

  function handleRename(title: string) {
    renameMutation.mutate(title, {
      onSuccess: () => {
        toast.success("Renamed");
        setRenaming(false);
      },
      onError: () => toast.error("Couldn't rename this draft."),
    });
  }

  return (
    // No font-reading here: the chrome (heading, actions, revision timeline) stays sans;
    // draft-section.tsx already applies the reading face to each section's own body text.
    // A <div>, not a second <main>: AppShell's own SidebarInset is already the page's one main
    // landmark, and print.css's [data-draft-print-root] selectors key off the attribute, not the tag.
    <div data-draft-print-root className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <PageHeader
        title={draft.title}
        description={revisionLabel(draft.revisionNumber)}
        actions={
          <Button type="button" variant="ghost" size="sm" className="print:hidden" onClick={() => setRenaming(true)}>
            <PencilLine aria-hidden="true" />
            Rename
          </Button>
        }
      />

      <ModelUsedNote modelUsed={draft.modelUsed} />

      {draft.mode === "document_grounded" &&
        (basedOnGone ? (
          <InlineNotice>{GROUNDING_DOCUMENT_GONE_NOTICE}</InlineNotice>
        ) : (
          groundedAndAvailable &&
          basedOnQuery.isSuccess && (
            <p className="text-sm">
              <Link href={`/documents/${draft.groundingDocumentId}`} className="text-primary underline-offset-4 hover:underline">
                {basedOnLabel(basedOnQuery.data.document.title)}
              </Link>
            </p>
          )
        ))}

      <div className="flex flex-col gap-6">
        {draft.sections.map((section) => (
          <DraftSection key={section.key} section={section} />
        ))}
      </div>

      <div className="print:hidden">
        {revisionsQuery.isLoading && <Skeleton className="h-24 w-full" />}
        {revisionsQuery.isError && (
          <ErrorState
            code={revisionsQuery.error instanceof ApiError ? revisionsQuery.error.code : "INTERNAL_ERROR"}
            retryAfterSeconds={revisionsQuery.error instanceof ApiError ? revisionsQuery.error.retryAfterSeconds : undefined}
            onRetry={() => revisionsQuery.refetch()}
          />
        )}
        {revisionsQuery.data && (
          <RevisionTimeline
            revisions={revisionsQuery.data.items}
            onSelectRevision={(id) => router.push(`/drafts/${id}`)}
            onGoToLatest={() => {
              const latest = revisionsQuery.data.items.find((entry) => entry.isLatest);
              if (latest) router.push(`/drafts/${latest.id}`);
            }}
          />
        )}
      </div>

      {reviseMutation.error instanceof ApiError && <DraftErrorBanner error={reviseMutation.error} />}
      <ReviseForm onSubmit={handleRevise} submitting={reviseMutation.isPending} offline={isOffline} />

      <div className="print:hidden">
        <ExportMenu exportText={draft.content} exportFilename="draft.txt" copyText={draft.content} />
      </div>

      {renaming && (
        <RenameDialog
          open
          itemType="draft"
          currentTitle={draft.title}
          onSave={handleRename}
          onCancel={() => setRenaming(false)}
          submitting={renameMutation.isPending}
        />
      )}
    </div>
  );
}
