"use client";

/**
 * /projects. The signInAvailable x principal matrix: !signInAvailable -> InlineNotice, no grid at
 * all; guest -> empty grid state that nudges instead of creating; user -> the real grid.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { SignInNudge } from "@/components/upload";
import { apiFetch, apiFetchJson, ApiError } from "@/lib/api";
import { useSession, sessionSignInAvailable } from "@/lib/session/use-session";
import { ConfirmDeleteDialog } from "@/components/shell/confirm-delete-dialog";
import { ProjectCard } from "@/components/projects/project-card";
import { PageHeader } from "@/components/page/page-header";
import { ProjectDialog, type ProjectDialogSaveInput } from "@/components/projects/project-dialog";
import type { ProjectsListOutput, ProjectOutput } from "@/shared/contracts/projects";
import type { z } from "zod";

type ProjectsList = z.infer<typeof ProjectsListOutput>;
type Project = z.infer<typeof ProjectOutput>;

type DialogState = { mode: "create" } | { mode: "rename"; project: Project } | { mode: "delete"; project: Project } | null;

export default function ProjectsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [showNudge, setShowNudge] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const signInAvailable = sessionSignInAvailable(session);
  const isGuest = session.data?.kind === "guest";

  const projects = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => apiFetchJson<ProjectsList>("/api/projects"),
    enabled: signInAvailable,
    retry: false,
  });

  function handleNewProjectClick() {
    if (isGuest) {
      setShowNudge(true);
      return;
    }
    setDialog({ mode: "create" });
  }

  async function handleSave(input: ProjectDialogSaveInput) {
    setSubmitting(true);
    try {
      if (dialog?.mode === "rename") {
        await apiFetch(`/api/projects/${dialog.project.id}`, { method: "PATCH", json: { name: input.name } });
        toast.success("Renamed");
      } else {
        await apiFetch("/api/projects", { method: "POST", json: { name: input.name, icon: input.icon } });
        toast.success("Project created");
      }
      void queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      setDialog(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (dialog?.mode !== "delete") return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/projects/${dialog.project.id}`, { method: "DELETE" });
      void queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      toast.success("Deleted");
      setDialog(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (session.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (!signInAvailable) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
        <PageHeader title="Projects" />
        <InlineNotice>Projects need an account, and account sign-in isn&apos;t turned on for this build yet.</InlineNotice>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      <PageHeader
        title="Projects"
        actions={
          <>
            <Button className="hidden sm:inline-flex" onClick={handleNewProjectClick}>
              New project
            </Button>
            <Button className="sm:hidden" size="icon" aria-label="New project" onClick={handleNewProjectClick}>
              <Plus aria-hidden="true" />
            </Button>
          </>
        }
      />

      {showNudge && <SignInNudge context="save" onSignIn={() => router.push("/sign-in")} />}

      {projects.isError ? (
        <ErrorState code={projects.error instanceof ApiError ? projects.error.code : "INTERNAL_ERROR"} retryAfterSeconds={projects.error instanceof ApiError ? projects.error.retryAfterSeconds : undefined} onRetry={() => projects.refetch()} />
      ) : (projects.data?.projects.length ?? 0) === 0 ? (
        <EmptyState
          heading="No projects yet"
          body="Projects keep your documents, comparisons, drafts and chats together, and they don't expire."
          action={{ label: "New project", onClick: handleNewProjectClick }}
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
          {(projects.data?.projects ?? []).map((project) => (
            <ProjectCard
              key={project.id}
              id={project.id}
              name={project.name}
              icon={project.icon}
              updatedAtMs={Date.parse(project.updatedAt)}
              onRename={() => setDialog({ mode: "rename", project })}
              onDelete={() => setDialog({ mode: "delete", project })}
            />
          ))}
        </div>
      )}

      {(dialog?.mode === "create" || dialog?.mode === "rename") && (
        <ProjectDialog
          open
          mode={dialog.mode}
          initialName={dialog.mode === "rename" ? dialog.project.name : ""}
          initialIcon={dialog.mode === "rename" ? dialog.project.icon : null}
          onSave={handleSave}
          onCancel={() => setDialog(null)}
          submitting={submitting}
        />
      )}
      {dialog?.mode === "delete" && (
        <ConfirmDeleteDialog
          open
          itemType="project"
          itemTitle={dialog.project.name}
          description={`Delete '${dialog.project.name}'? Items in this project are kept, just removed from it.`}
          onConfirm={handleDelete}
          onCancel={() => setDialog(null)}
          submitting={submitting}
        />
      )}
    </div>
  );
}
