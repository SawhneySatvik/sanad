"use client";

/**
 * /drafts/new's own client orchestrator. Owns every field DraftComposer renders so it can also gate
 * the documents-list fetch on `mode === "document_grounded"` (no need to pay for the list on a
 * from-scratch draft) and react to the async `?grounding=<documentId>` deep-link resolve before the
 * composer ever mounts with a seeded value.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, useIsOffline } from "@/lib/api";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { PageHeader } from "@/components/page/page-header";
import type { CreateDraftInput } from "@/shared/contracts/drafts";
import { DraftComposer, type DraftMode } from "./draft-composer";
import { DraftErrorBanner } from "./draft-error-banner";
import type { FromScratchDocumentTypeId } from "@/lib/copy/document-type-labels";
import { mergeGroundingOptions, optionFromDocumentDetail, optionFromListRow } from "./grounding-options";
import { useGroundingDocumentQuery } from "./queries/use-grounding-document-query";
import { useDocumentsListQuery } from "./queries/use-documents-list-query";
import { useCreateDraftMutation } from "./queries/use-create-draft-mutation";
import { GROUNDING_DEEP_LINK_FAILED_NOTICE, NEW_DRAFT_HEADING } from "./copy";

export interface DraftNewClientProps {
  initialGroundingDocumentId: string | null;
}

export function DraftNewClient({ initialGroundingDocumentId }: DraftNewClientProps) {
  const router = useRouter();
  const isOffline = useIsOffline();

  // Latched once at mount: router.replace("/drafts/new") clears the URL param below, at which point
  // a fresh prop value would otherwise read as undefined and silently drop the preselection.
  const [groundingParam] = useState(initialGroundingDocumentId);
  const [deepLinkFailed, setDeepLinkFailed] = useState(false);
  const clearedParam = useRef(false);

  const [mode, setMode] = useState<DraftMode>("unset");
  const [documentType, setDocumentType] = useState<FromScratchDocumentTypeId | null>(null);
  const [groundingDocumentId, setGroundingDocumentId] = useState<string | null>(null);
  const [userInstructions, setUserInstructions] = useState("");

  const deepLinkQuery = useGroundingDocumentQuery(groundingParam);
  const listQuery = useDocumentsListQuery(mode === "document_grounded");
  const createMutation = useCreateDraftMutation();

  // React's own "adjust state when a dependency changes" idiom (RetryAfterNotice's own comment
  // names it) — a direct setState call during render, never inside an effect, guarded so it only
  // fires once per actual settle rather than on every render. `settled` tracks whether this
  // deep-link resolve has already been applied; `isSuccess`/`isError` alone can't gate it the same
  // way, since they stay true on every later render too.
  const [settled, setSettled] = useState(false);
  if (groundingParam && !settled) {
    if (deepLinkQuery.isSuccess) {
      setSettled(true);
      setMode("document_grounded");
      setGroundingDocumentId(groundingParam);
    } else if (deepLinkQuery.isError) {
      setSettled(true);
      if (deepLinkQuery.error instanceof ApiError && deepLinkQuery.error.code === "NOT_FOUND") {
        setDeepLinkFailed(true);
      }
    }
  }

  // The one real side effect here (a navigation, not a setState) — clears the URL param exactly
  // once the deep-link resolve above has settled, success or failure alike.
  useEffect(() => {
    if (groundingParam && settled && !clearedParam.current) {
      clearedParam.current = true;
      router.replace("/drafts/new");
    }
  }, [groundingParam, settled, router]);

  const preselectedOption =
    deepLinkQuery.isSuccess && groundingParam ? optionFromDocumentDetail(deepLinkQuery.data) : null;
  const groundingOptions = mergeGroundingOptions((listQuery.data?.items ?? []).map(optionFromListRow), preselectedOption);
  const groundingOptionsLoading = mode === "document_grounded" && listQuery.isLoading && !preselectedOption;

  function handleModeChange(next: "from_scratch" | "document_grounded") {
    setMode(next);
    if (next === "from_scratch") setGroundingDocumentId(null);
    else setDocumentType(null);
  }

  function handleSubmit() {
    if (mode === "from_scratch" && documentType) {
      const input: CreateDraftInput = { mode: "from_scratch", documentType, userInstructions: userInstructions.trim(), jurisdiction: "IN" };
      createMutation.mutate(input, { onSuccess: (draft) => router.push(`/drafts/${draft.id}`) });
    } else if (mode === "document_grounded" && groundingDocumentId) {
      const input: CreateDraftInput = {
        mode: "document_grounded",
        documentType: "grounded_response",
        groundingDocumentId,
        userInstructions: userInstructions.trim(),
        jurisdiction: "IN",
      };
      createMutation.mutate(input, { onSuccess: (draft) => router.push(`/drafts/${draft.id}`) });
    }
  }

  return (
    // A <div>, not a second <main>: AppShell's own SidebarInset is already the page's one main landmark.
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <PageHeader title={NEW_DRAFT_HEADING} />

      {deepLinkFailed && <InlineNotice>{GROUNDING_DEEP_LINK_FAILED_NOTICE}</InlineNotice>}
      {createMutation.error instanceof ApiError && <DraftErrorBanner error={createMutation.error} />}

      <DraftComposer
        mode={mode}
        onModeChange={handleModeChange}
        documentType={documentType}
        onDocumentTypeChange={setDocumentType}
        groundingDocumentId={groundingDocumentId}
        onGroundingDocumentIdChange={setGroundingDocumentId}
        groundingOptions={groundingOptions}
        groundingOptionsLoading={groundingOptionsLoading}
        userInstructions={userInstructions}
        onUserInstructionsChange={setUserInstructions}
        onSubmit={handleSubmit}
        submitting={createMutation.isPending}
        offline={isOffline}
      />
    </div>
  );
}
