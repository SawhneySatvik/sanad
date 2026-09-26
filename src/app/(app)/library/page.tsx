"use client";

/**
 * /library. Every item the principal has — documents, comparisons, drafts, chats — one screen,
 * newest activity first, with rename and delete. Session-change privacy (a stale cache entry from a
 * previous principal painting for one frame) is handled app-wide by sync.ts's
 * `notifySessionChanged` (`queryClient.resetQueries()` on sign-in/out/claim), not by anything here.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, apiFetchJson, ApiError } from "@/lib/api";
import { useSession, sessionSignInAvailable } from "@/lib/session/use-session";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { RenameDialog } from "@/components/shell/rename-dialog";
import { ConfirmDeleteDialog, type DeleteImpact } from "@/components/shell/confirm-delete-dialog";
import { useLocalThreads, renameLocalThread, deleteLocalThread, localThreadActivityMs } from "@/components/shell/local-threads";
import { LibraryTable, type LibraryTab } from "@/components/library/library-table";
import { PageHeader } from "@/components/page/page-header";
import {
  useComparisonLibraryList,
  useDocumentLibraryList,
  useDraftLibraryList,
  useThreadLibraryList,
  type LibraryListState,
} from "@/components/library/use-library-list";
import { mergeLibraryRows } from "@/components/library/merge-library-rows";
import { localThreadToRow, nowMs, type LibraryItemType, type LibraryRow } from "@/components/library/library-row";
import { libraryDeleteDescription } from "@/components/library/delete-copy";

const TABS: { value: LibraryTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "document", label: "Documents" },
  { value: "comparison", label: "Comparisons" },
  { value: "draft", label: "Drafts" },
  { value: "thread", label: "Chats" },
];

const API_PATH_BY_TYPE: Record<LibraryItemType, string> = {
  document: "/api/documents",
  comparison: "/api/comparisons",
  draft: "/api/drafts",
  thread: "/api/threads",
};

const LIST_KIND_BY_TYPE: Record<LibraryItemType, "documents" | "comparisons" | "drafts" | "threads"> = {
  document: "documents",
  comparison: "comparisons",
  draft: "drafts",
  thread: "threads",
};

const EMPTY_COPY: Record<LibraryTab, { heading: string; body?: string; actionLabel: string; href: string }> = {
  all: {
    heading: "Nothing here yet",
    body: "Upload a document, compare two versions, start a draft, or ask a question — everything you do shows up here.",
    actionLabel: "Start a chat",
    href: "/chat",
  },
  document: { heading: "No documents yet", actionLabel: "Upload a document", href: "/chat" },
  comparison: { heading: "No comparisons yet", actionLabel: "Compare documents", href: "/compare" },
  draft: { heading: "No drafts yet", actionLabel: "Start a draft", href: "/drafts/new" },
  thread: { heading: "No chats yet", actionLabel: "Start a chat", href: "/chat" },
};

interface LibraryInfiniteCache {
  pages: { items: { id: string }[]; nextCursor: string | null }[];
  pageParams: unknown[];
}

type PendingAction =
  | { action: "rename"; row: LibraryRow }
  | { action: "delete"; row: LibraryRow; impact?: DeleteImpact; impactLoading?: boolean };

function toErrorCode(code: LibraryListState["errorCode"]): "RATE_LIMITED" | "INTERNAL_ERROR" | "NOT_FOUND" | "TIMEOUT" {
  if (code === "RATE_LIMITED" || code === "NOT_FOUND" || code === "TIMEOUT") return code;
  return "INTERNAL_ERROR";
}

export default function LibraryPage() {
  const [tab, setTab] = useState<LibraryTab>("all");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();

  const documents = useDocumentLibraryList();
  const comparisons = useComparisonLibraryList();
  const drafts = useDraftLibraryList();
  const threads = useThreadLibraryList();
  const localThreadEntries = useLocalThreads();

  const localRows: LibraryRow[] = useMemo(() => {
    const now = nowMs();
    return localThreadEntries.map((entry, index) =>
      localThreadToRow({
        id: entry.id,
        title: entry.thread.title || "New chat",
        updatedAtMs: localThreadActivityMs(entry, index, now),
      }),
    );
  }, [localThreadEntries]);

  const merged = useMemo(
    () =>
      mergeLibraryRows({
        lists: [
          { rows: documents.rows, exhausted: documents.exhausted },
          { rows: comparisons.rows, exhausted: comparisons.exhausted },
          { rows: drafts.rows, exhausted: drafts.exhausted },
          { rows: threads.rows, exhausted: threads.exhausted },
        ],
        localRows,
      }),
    [documents.rows, documents.exhausted, comparisons.rows, comparisons.exhausted, drafts.rows, drafts.exhausted, threads.rows, threads.exhausted, localRows],
  );

  const listByTab: Record<Exclude<LibraryTab, "all">, LibraryListState & { rows: LibraryRow[] }> = {
    document: documents,
    comparison: comparisons,
    draft: drafts,
    thread: { ...threads, rows: [...threads.rows, ...localRows] },
  };

  const signInAvailable = sessionSignInAvailable(session);
  const isGuest = session.data?.kind === "guest";

  function closePending() {
    setPending(null);
  }

  async function openDelete(row: LibraryRow) {
    setPending({ action: "delete", row });
    if (row.itemType === "document" && !row.isLocal) {
      setPending({ action: "delete", row, impactLoading: true });
      try {
        const impact = await apiFetchJson<DeleteImpact>(`/api/documents/${row.id}/delete-impact`);
        setPending({ action: "delete", row, impact });
      } catch {
        setPending({ action: "delete", row });
      }
    }
  }

  async function handleRename(title: string) {
    if (!pending || pending.action !== "rename") return;
    const { row } = pending;
    setSubmitting(true);
    try {
      if (row.isLocal) {
        renameLocalThread(row.id, title);
      } else {
        const kind = LIST_KIND_BY_TYPE[row.itemType];
        const response = await apiFetchJson<{ id: string }>(`${API_PATH_BY_TYPE[row.itemType]}/${row.id}`, {
          method: "PATCH",
          json: { title },
        });
        queryClient.setQueriesData<LibraryInfiniteCache>({ queryKey: [kind, "list", "library"] }, (old) => {
          if (!old) return old;
          return { ...old, pages: old.pages.map((page) => ({ ...page, items: page.items.map((item) => (item.id === row.id ? response : item)) })) };
        });
        void queryClient.invalidateQueries({ queryKey: [kind, "list"] });
        if (row.itemType === "document") void queryClient.invalidateQueries({ queryKey: ["comparisons", "list"] });
      }
      toast.success("Renamed");
      closePending();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!pending || pending.action !== "delete") return;
    const { row } = pending;
    setSubmitting(true);
    try {
      if (row.isLocal) {
        deleteLocalThread(row.id);
      } else {
        await apiFetch(`${API_PATH_BY_TYPE[row.itemType]}/${row.id}`, { method: "DELETE" });
        const kind = LIST_KIND_BY_TYPE[row.itemType];
        void queryClient.invalidateQueries({ queryKey: [kind, "list"] });
        if (row.itemType === "document") {
          void queryClient.invalidateQueries({ queryKey: ["comparisons", "list"] });
          void queryClient.invalidateQueries({ queryKey: ["drafts", "list"] });
          if (row.projectId) void queryClient.invalidateQueries({ queryKey: ["projects", "detail", row.projectId] });
        }
      }
      toast.success("Deleted");
      closePending();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveToProject(row: LibraryRow, projectId: string) {
    await apiFetch(`${API_PATH_BY_TYPE[row.itemType]}/${row.id}/save-to-project`, { method: "POST", json: { projectId } });
    const kind = LIST_KIND_BY_TYPE[row.itemType];
    void queryClient.invalidateQueries({ queryKey: [kind, "list"] });
    void queryClient.invalidateQueries({ queryKey: ["projects", "detail", projectId] });
    const cached = queryClient.getQueryData<{ projects: { id: string; name: string }[] }>(["projects", "list"]);
    const name = cached?.projects.find((p) => p.id === projectId)?.name;
    toast.success(name ? `Saved to '${name}'` : "Saved to project");
  }

  function renderTabBody(activeTab: LibraryTab) {
    if (activeTab === "all") {
      const anyLoading = documents.isLoading || comparisons.isLoading || drafts.isLoading || threads.isLoading;
      if (anyLoading && merged.rows.length === 0) {
        return (
          <div className="flex flex-col gap-2 py-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        );
      }
      const failedLists = [
        { kind: "documents", state: documents },
        { kind: "comparisons", state: comparisons },
        { kind: "drafts", state: drafts },
        { kind: "threads", state: threads },
      ].filter((l) => l.state.isError);

      if (merged.rows.length === 0 && failedLists.length === 0) {
        return <EmptyState heading={EMPTY_COPY.all.heading} body={EMPTY_COPY.all.body} action={{ label: EMPTY_COPY.all.actionLabel, onClick: () => router.push(EMPTY_COPY.all.href) }} />;
      }

      return (
        <div className="flex flex-col gap-4">
          {merged.rows.length > 0 && (
            <LibraryTable
              tab="all"
              rows={merged.rows}
              onRename={(row) => setPending({ action: "rename", row })}
              onDelete={(row) => void openDelete(row)}
              signInAvailable={signInAvailable}
              isGuest={isGuest}
              onSignIn={() => router.push("/sign-in")}
              onSaveToProject={handleSaveToProject}
            />
          )}
          {failedLists.map(({ kind, state }) => (
            <ErrorState
              key={kind}
              code={toErrorCode(state.errorCode)}
              retryAfterSeconds={state.retryAfterSeconds}
            />
          ))}
          {merged.hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                if (!documents.exhausted) documents.fetchNextPage();
                if (!comparisons.exhausted) comparisons.fetchNextPage();
                if (!drafts.exhausted) drafts.fetchNextPage();
                if (!threads.exhausted) threads.fetchNextPage();
              }}
            >
              Load more
            </Button>
          )}
        </div>
      );
    }

    const list = listByTab[activeTab];
    if (list.isLoading && list.rows.length === 0) {
      return (
        <div className="flex flex-col gap-2 py-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      );
    }
    if (list.isError && list.rows.length === 0) {
      return <ErrorState code={toErrorCode(list.errorCode)} retryAfterSeconds={list.retryAfterSeconds} />;
    }
    if (list.rows.length === 0) {
      const copy = EMPTY_COPY[activeTab];
      return <EmptyState heading={copy.heading} action={{ label: copy.actionLabel, onClick: () => router.push(copy.href) }} />;
    }
    return (
      <div className="flex flex-col gap-4">
        <LibraryTable
          tab={activeTab}
          rows={list.rows}
          onRename={(row) => setPending({ action: "rename", row })}
          onDelete={(row) => void openDelete(row)}
          signInAvailable={signInAvailable}
          isGuest={isGuest}
          onSignIn={() => router.push("/sign-in")}
          onSaveToProject={handleSaveToProject}
        />
        {list.isError && <ErrorState code={toErrorCode(list.errorCode)} retryAfterSeconds={list.retryAfterSeconds} />}
        {!list.exhausted && (
          <Button variant="outline" size="sm" className="self-start" onClick={() => list.fetchNextPage()}>
            Load more
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-6">
      <PageHeader title="Library" />

      <Tabs value={tab} onValueChange={(value) => setTab(value as LibraryTab)}>
        <TabsList variant="line" className="overflow-x-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* A real TabsContent per tab (not just the active tab's body rendered outside Tabs
            entirely) — otherwise each TabsTrigger's own aria-controls points at an id with no
            matching element in the DOM at all, a critical axe violation (aria-valid-attr-value). */}
        {TABS.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            {tab === t.value && renderTabBody(tab)}
          </TabsContent>
        ))}
      </Tabs>

      {pending?.action === "rename" && (
        <RenameDialog
          open
          itemType={pending.row.itemType}
          currentTitle={pending.row.title}
          onSave={handleRename}
          onCancel={closePending}
          submitting={submitting}
        />
      )}
      {pending?.action === "delete" && (
        <ConfirmDeleteDialog
          open
          itemType={pending.row.itemType}
          itemTitle={pending.row.title}
          description={
            pending.impactLoading
              ? "Checking what this affects…"
              : libraryDeleteDescription(pending.row.itemType, {
                  title: pending.row.title,
                  impact: pending.impact,
                  revisionCount: pending.row.itemType === "draft" ? pending.row.revisionCount : undefined,
                })
          }
          revisionCount={pending.row.itemType === "draft" ? pending.row.revisionCount : undefined}
          onConfirm={handleDelete}
          onCancel={closePending}
          submitting={submitting || pending.impactLoading}
        />
      )}
    </div>
  );
}
