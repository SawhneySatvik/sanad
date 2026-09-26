"use client";

/**
 * /projects/[id]. Metadata only, four handle lists — each item re-verifies fresh the moment it's
 * actually opened via its own route. Phone collapses the four sections into an Accordion (mirroring
 * FindingsPane's category-group pattern); desktop keeps them as plain sections.
 */

import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { apiFetch, apiFetchJson, ApiError } from "@/lib/api";
import { useSession, sessionSignInAvailable } from "@/lib/session/use-session";
import { useIsMobile } from "@/hooks/use-mobile";
import { ItemMenu } from "@/components/shell/item-menu";
import { RenameDialog } from "@/components/shell/rename-dialog";
import { ConfirmDeleteDialog } from "@/components/shell/confirm-delete-dialog";
import { ProjectDialog, type ProjectDialogSaveInput } from "@/components/projects/project-dialog";
import { ProjectSectionTable, type ProjectSectionRow } from "@/components/projects/project-section-table";
import { unassignDescription, unassignDraftDescription, countDraftChainInProject } from "@/components/projects/unassign-copy";
import { relativeTimeLabel } from "@/components/library/relative-time";
import { PageHeader } from "@/components/page/page-header";
import type { ProjectDetailOutput } from "@/shared/contracts/projects";
import type { z } from "zod";

type ProjectDetail = z.infer<typeof ProjectDetailOutput>;

type ItemKind = "document" | "comparison" | "draft" | "thread";
const PATH_BY_KIND: Record<ItemKind, string> = {
  document: "/api/documents",
  comparison: "/api/comparisons",
  draft: "/api/drafts",
  thread: "/api/threads",
};
const LIST_KIND_BY_TYPE: Record<ItemKind, "documents" | "comparisons" | "drafts" | "threads"> = {
  document: "documents",
  comparison: "comparisons",
  draft: "drafts",
  thread: "threads",
};

type PendingAction =
  | { action: "project-rename" }
  | { action: "project-delete" }
  | { action: "rename"; kind: ItemKind; row: ProjectSectionRow }
  | { action: "unassign"; kind: ItemKind; row: ProjectSectionRow };

function toErrorCode(err: unknown): "RATE_LIMITED" | "NOT_FOUND" | "INTERNAL_ERROR" {
  if (err instanceof ApiError && (err.code === "RATE_LIMITED" || err.code === "NOT_FOUND")) return err.code;
  return "INTERNAL_ERROR";
}

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const isMobile = useIsMobile();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const signInAvailable = sessionSignInAvailable(session);

  const detail = useQuery({
    queryKey: ["projects", "detail", id],
    queryFn: () => apiFetchJson<ProjectDetail>(`/api/projects/${id}`),
    enabled: signInAvailable,
    retry: false,
  });

  const documentRows: ProjectSectionRow[] = useMemo(
    () => (detail.data?.documents ?? []).map((d) => ({ id: d.id, title: d.title, href: `/documents/${d.id}` })),
    [detail.data],
  );
  const comparisonRows: ProjectSectionRow[] = useMemo(
    () => (detail.data?.comparisons ?? []).map((c) => ({ id: c.id, title: c.title, href: `/compare/${c.id}` })),
    [detail.data],
  );
  const draftRows: ProjectSectionRow[] = useMemo(
    () =>
      (detail.data?.drafts ?? []).map((d) => ({
        id: d.id,
        title: d.title,
        secondary: `revision ${d.revisionNumber}`,
        href: `/drafts/${d.id}`,
      })),
    [detail.data],
  );
  const threadRows: ProjectSectionRow[] = useMemo(
    () => (detail.data?.threads ?? []).map((t) => ({ id: t.id, title: t.title ?? "New chat", href: `/chat/${t.id}` })),
    [detail.data],
  );

  function closePending() {
    setPending(null);
  }

  async function handleRename(title: string) {
    if (!pending || pending.action !== "rename") return;
    setSubmitting(true);
    try {
      await apiFetch(`${PATH_BY_KIND[pending.kind]}/${pending.row.id}`, { method: "PATCH", json: { title } });
      void queryClient.invalidateQueries({ queryKey: [LIST_KIND_BY_TYPE[pending.kind], "list"] });
      void queryClient.invalidateQueries({ queryKey: ["projects", "detail", id] });
      toast.success("Renamed");
      closePending();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUnassign() {
    if (!pending || pending.action !== "unassign") return;
    setSubmitting(true);
    try {
      await apiFetch(`${PATH_BY_KIND[pending.kind]}/${pending.row.id}/project`, { method: "DELETE" });
      void queryClient.invalidateQueries({ queryKey: [LIST_KIND_BY_TYPE[pending.kind], "list"] });
      void queryClient.invalidateQueries({ queryKey: ["projects", "detail", id] });
      toast.success("Removed from project");
      closePending();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "That item is no longer in this project.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProjectRename(input: ProjectDialogSaveInput) {
    setSubmitting(true);
    try {
      await apiFetch(`/api/projects/${id}`, { method: "PATCH", json: { name: input.name } });
      void queryClient.invalidateQueries({ queryKey: ["projects", "detail", id] });
      void queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      toast.success("Renamed");
      closePending();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleProjectDelete() {
    setSubmitting(true);
    try {
      await apiFetch(`/api/projects/${id}`, { method: "DELETE" });
      void queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      toast.success("Deleted");
      router.push("/projects");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  if (!signInAvailable && !session.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
        <InlineNotice>Projects need an account, and account sign-in isn&apos;t turned on for this build yet.</InlineNotice>
      </div>
    );
  }

  if (session.isPending || (detail.isLoading && signInAvailable)) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
        <ErrorState code={toErrorCode(detail.error)} retryAfterSeconds={detail.error instanceof ApiError ? detail.error.retryAfterSeconds : undefined} />
      </div>
    );
  }

  if (!detail.data) return null;
  const { project } = detail.data;
  const totalItems = documentRows.length + comparisonRows.length + draftRows.length + threadRows.length;

  function unassignDialogFor(pendingUnassign: Extract<PendingAction, { action: "unassign" }>) {
    if (pendingUnassign.kind === "draft") {
      const count = countDraftChainInProject(detail.data!.drafts, pendingUnassign.row.id);
      return unassignDraftDescription(count);
    }
    return unassignDescription(pendingUnassign.row.title);
  }

  const sections = [
    { key: "documents" as const, label: "Documents", rows: documentRows },
    { key: "comparisons" as const, label: "Comparisons", rows: comparisonRows },
    { key: "drafts" as const, label: "Drafts", rows: draftRows },
    { key: "chats" as const, label: "Chats", rows: threadRows },
  ];
  const kindByKey: Record<(typeof sections)[number]["key"], ItemKind> = {
    documents: "document",
    comparisons: "comparison",
    drafts: "draft",
    chats: "thread",
  };

  function sectionBody(kind: ItemKind, rows: ProjectSectionRow[]) {
    if (rows.length === 0) return <p className="px-1 py-2 text-sm text-muted-foreground">Nothing here</p>;
    return (
      <ProjectSectionTable
        rows={rows}
        onRename={(row) => setPending({ action: "rename", kind, row })}
        onRemoveFromProject={(row) => setPending({ action: "unassign", kind, row })}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <PageHeader
        title={project.name}
        description={`Updated ${relativeTimeLabel(Date.parse(project.updatedAt))}`}
        actions={
          <div className="group/menu-item relative [&_[data-sidebar=menu-action]]:opacity-100">
            <ItemMenu
              itemId={project.id}
              itemType="project"
              label={project.name}
              onRename={() => setPending({ action: "project-rename" })}
              onDelete={() => setPending({ action: "project-delete" })}
            />
          </div>
        }
      />

      {totalItems === 0 ? (
        <EmptyState
          heading="Nothing in this project yet"
          body="Save a document, comparison, draft or chat here from its own menu, or from the Library."
        />
      ) : isMobile ? (
        <Accordion type="single" collapsible defaultValue={sections.find((s) => s.rows.length > 0)?.key}>
          {sections.map((section) => (
            <AccordionItem key={section.key} value={section.key}>
              <AccordionTrigger aria-label={`${section.label}, ${section.rows.length} items`}>
                {section.label} ({section.rows.length})
              </AccordionTrigger>
              <AccordionContent>{sectionBody(kindByKey[section.key], section.rows)}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      ) : (
        <div className="flex flex-col gap-8">
          {sections.map((section) => (
            <section key={section.key} aria-labelledby={`section-${section.key}`}>
              <h2 id={`section-${section.key}`} className="mb-2 font-display text-lg font-medium">
                {section.label} ({section.rows.length})
              </h2>
              {sectionBody(kindByKey[section.key], section.rows)}
            </section>
          ))}
        </div>
      )}

      {pending?.action === "project-rename" && (
        <ProjectDialog
          open
          mode="rename"
          initialName={project.name}
          initialIcon={project.icon}
          onSave={handleProjectRename}
          onCancel={closePending}
          submitting={submitting}
        />
      )}
      {pending?.action === "project-delete" && (
        <ConfirmDeleteDialog
          open
          itemType="project"
          itemTitle={project.name}
          description={`Delete '${project.name}'? Items in this project are kept, just removed from it.`}
          onConfirm={handleProjectDelete}
          onCancel={closePending}
          submitting={submitting}
        />
      )}
      {pending?.action === "rename" && (
        <RenameDialog
          open
          itemType={pending.kind}
          currentTitle={pending.row.title}
          onSave={handleRename}
          onCancel={closePending}
          submitting={submitting}
        />
      )}
      {pending?.action === "unassign" && (
        <ConfirmDeleteDialog
          open
          variant="unassign"
          itemType={pending.kind}
          itemTitle={pending.row.title}
          description={unassignDialogFor(pending)}
          onConfirm={handleUnassign}
          onCancel={closePending}
          submitting={submitting}
        />
      )}
    </div>
  );
}
