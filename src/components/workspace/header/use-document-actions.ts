"use client";

/**
 * DocumentHeader's own ItemMenu (Rename/Delete/Save to project) — identical semantics and endpoints
 * to the sidebar row's own menu (flows/F5-account.md step 6), confirmed as its own real interaction
 * on this route rather than a sidebar-only affordance. Deleting the open document always navigates
 * this route away: unlike the sidebar's own delete (which only redirects when the deleted row happens
 * to be the currently-open route), this menu's document IS the open route's document every time.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { documentQueryKey } from "../document/use-document-query";

export type DocumentPendingAction = "rename" | "delete" | null;

export interface UseDocumentActionsResult {
  pending: DocumentPendingAction;
  submitting: boolean;
  openRename: () => void;
  openDelete: () => void;
  closePending: () => void;
  rename: (title: string) => Promise<void>;
  remove: () => Promise<void>;
}

export function useDocumentActions(documentId: string): UseDocumentActionsResult {
  const [pending, setPending] = useState<DocumentPendingAction>(null);
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const rename = useCallback(
    async (title: string) => {
      setSubmitting(true);
      try {
        await apiFetch(`/api/documents/${encodeURIComponent(documentId)}`, { method: "PATCH", json: { title } });
        await queryClient.invalidateQueries({ queryKey: ["documents", "list"] });
        await queryClient.invalidateQueries({ queryKey: documentQueryKey(documentId) });
        toast.success("Renamed");
        setPending(null);
      } catch {
        toast.error("Couldn't rename this document.");
      } finally {
        setSubmitting(false);
      }
    },
    [documentId, queryClient],
  );

  const remove = useCallback(async () => {
    setSubmitting(true);
    try {
      await apiFetch(`/api/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
      // Dropped before navigating away, not merely invalidated — a stale 404 refetch racing the
      // navigation below must never repaint this same route with an error flash first.
      queryClient.removeQueries({ queryKey: documentQueryKey(documentId) });
      void queryClient.invalidateQueries({ queryKey: ["documents", "list"] });
      toast.success("Deleted");
      setPending(null);
      router.push("/library");
    } catch {
      toast.error("Couldn't delete this document.");
    } finally {
      setSubmitting(false);
    }
  }, [documentId, queryClient, router]);

  return {
    pending,
    submitting,
    openRename: () => setPending("rename"),
    openDelete: () => setPending("delete"),
    closePending: () => setPending(null),
    rename,
    remove,
  };
}
