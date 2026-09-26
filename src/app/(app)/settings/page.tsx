"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetchJson, ApiError } from "@/lib/api";
import { useSession, SESSION_FAILURE_NOTICE } from "@/lib/session/use-session";
import { notifySessionChanged } from "@/lib/session/sync";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineNotice } from "@/components/feedback/inline-notice";
import { useIsOffline } from "@/lib/api/offline-status";
import { ConfirmDeleteDialog } from "@/components/shell/confirm-delete-dialog";
import { ThemeAppearance } from "@/components/shell/theme-appearance";
import { clearSabootLocalStorage } from "@/components/shell/clear-saboot-storage";
import { refreshLocalThreads } from "@/components/shell/local-threads";
import { DeleteAllOutput } from "@/shared/contracts/library";
import type { z } from "zod";

type DeleteAllOutputT = z.infer<typeof DeleteAllOutput>;
type DeletedCounts = DeleteAllOutputT["deleted"];

// A session fetch failure can't tell guest from user, so it can't state a real TTL or the right
// scope either — one deliberately vaguer sentence stands in until the session is known again.
const SESSION_FAILURE_DATA_COPY = "Deleting your data removes every document, comparison and draft you've created.";

function dataSectionCopy(kind: "guest" | "user", guestTtlHours: number): string {
  if (kind === "guest") {
    return `Deleting your data removes every document, comparison and draft this guest session created. Guest items are automatically deleted after about ${guestTtlHours} hours anyway.`;
  }
  return "Deleting your data permanently removes every document, comparison, draft, chat and project your account has created.";
}

function deletedCountsToast(deleted: DeletedCounts): string {
  const parts: string[] = [];
  if (deleted.documents > 0) parts.push(`${deleted.documents} document(s)`);
  if (deleted.comparisons > 0) parts.push(`${deleted.comparisons} comparison(s)`);
  if (deleted.drafts > 0) parts.push(`${deleted.drafts} draft(s)`);
  if (deleted.threads > 0) parts.push(`${deleted.threads} chat(s)`);
  if (deleted.projects > 0) parts.push(`${deleted.projects} project(s)`);
  if (parts.length === 0) return "Deleted 0 items.";
  return `Deleted ${parts.join(", ")}.`;
}

export default function SettingsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const offline = useIsOffline();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleConfirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await apiFetchJson<DeleteAllOutputT>("/api/me/data", { method: "DELETE" });
      clearSabootLocalStorage();
      // clearSabootLocalStorage sweeps raw storage keys directly — never through local-threads.ts's
      // own rename/delete mutators, the only two writers its snapshot cache already knows to
      // invalidate itself for. Without this, this same tab's RecentsList would keep showing every
      // deleted thread's title until some unrelated write happened to refresh the cache.
      refreshLocalThreads();
      // Awaited: router.push() below unmounts this page's session observer mid-refresh otherwise,
      // stranding /chat's own fresh observer reading the still-stale, pre-delete cache data.
      await notifySessionChanged(queryClient);
      toast.success(deletedCountsToast(result.deleted));
      setDialogOpen(false);
      router.push("/chat");
    } catch (err) {
      // Any non-2xx is a full failure for UI purposes: nothing is cleared client-side unless the
      // server confirmed success (the conservative, no-data-loss-on-ambiguity reading).
      setDeleteError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-10 px-4 py-10">
      <h1 className="font-display text-2xl font-medium">Settings</h1>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-medium">Appearance</h2>
        <ThemeAppearance />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-lg font-medium">Data</h2>
        {session.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : session.isError ? (
          <div className="flex flex-col gap-2">
            <InlineNotice tone="warning">{SESSION_FAILURE_NOTICE}</InlineNotice>
            <div>
              <Button variant="outline" size="sm" onClick={() => session.refetch()}>
                Try again
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{SESSION_FAILURE_DATA_COPY}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {dataSectionCopy(session.data.kind, session.data.guestTtlHours)}
          </p>
        )}
        {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
        <div>
          {/* Disabled on a failed session fetch too — a delete-all scope statement can't be trusted
              (guest vs. account, no real TTL) until the session is known again. */}
          <Button variant="destructive" disabled={offline || session.isError} onClick={() => setDialogOpen(true)}>
            Delete all my data
          </Button>
        </div>
      </section>

      <ConfirmDeleteDialog
        open={dialogOpen}
        itemType="all_data"
        description={
          session.isError
            ? SESSION_FAILURE_DATA_COPY
            : dataSectionCopy(session.data?.kind ?? "guest", session.data?.guestTtlHours ?? 0)
        }
        onConfirm={handleConfirmDelete}
        onCancel={() => setDialogOpen(false)}
        submitting={deleting}
      />
    </div>
  );
}
