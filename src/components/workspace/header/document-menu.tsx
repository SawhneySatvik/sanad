"use client";

/**
 * DocumentHeader's own menu (Rename, Delete, Save to project) — identical endpoints to the sidebar
 * row's own ItemMenu (flows/F5-account.md step 6), but not a reuse of that component: ItemMenu's
 * trigger is SidebarMenuAction, styled and absolutely positioned for a sidebar row (it also hides
 * entirely under an ancestor's `data-collapsible=icon`, which this header never sits inside) — a
 * header-local DropdownMenu with the same three items avoids force-fitting sidebar-only styling
 * outside the sidebar.
 *
 * "Save to project" renders whenever signInAvailable: the entry itself is gated on signInAvailable,
 * not on the caller's own principal — a guest sees it too, and gets SignInNudge instead of the real
 * picker when they click it (isGuest), never the entry hidden outright.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ellipsis } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RenameDialog } from "@/components/shell/rename-dialog";
import { ConfirmDeleteDialog, type DeleteImpact } from "@/components/shell/confirm-delete-dialog";
import { SignInNudge } from "@/components/upload";
import { apiFetch } from "@/lib/api";
import { useDocumentActions } from "./use-document-actions";
import { SaveToProjectDialog } from "./save-to-project-dialog";
import { SAVE_TO_PROJECT_LABEL } from "../copy";

export interface DocumentMenuProps {
  documentId: string;
  title: string;
  signInAvailable: boolean;
  isGuest: boolean;
  /** Set only on phone, where DocumentHeader has no room of its own for the Prepare/Compare/Draft
   * row — undefined on desktop, where that row still renders in the header body instead. */
  phoneLinks?: readonly { label: string; href: string }[];
}

export function DocumentMenu({ documentId, title, signInAvailable, isGuest, phoneLinks }: DocumentMenuProps) {
  const actions = useDocumentActions(documentId);
  const [savePanel, setSavePanel] = useState<"none" | "nudge" | "picker">("none");
  const router = useRouter();
  const queryClient = useQueryClient();

  const impactQuery = useMutation({
    mutationFn: () => apiFetch(`/api/documents/${encodeURIComponent(documentId)}/delete-impact`).then((r) => r.json() as Promise<DeleteImpact>),
  });

  const saveMutation = useMutation({
    mutationFn: (projectId: string) =>
      apiFetch(`/api/documents/${encodeURIComponent(documentId)}/save-to-project`, { method: "POST", json: { projectId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["documents", "list"] });
      toast.success("Saved to project");
      setSavePanel("none");
    },
    onError: () => toast.error("Couldn't save to project."),
  });

  function openDelete() {
    actions.openDelete();
    impactQuery.mutate();
  }

  return (
    <>
      {/* modal={false}: see item-menu.tsx — Radix's modal menu aria-hides the rest of the page
          without also stripping tabindex from what it hides, an aria-hidden-focus violation for
          any focusable control (the sidebar, the theme toggle) left behind it. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${title}`}
            className="relative before:absolute before:-inset-2 before:content-['']"
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {phoneLinks && phoneLinks.length > 0 && (
            <>
              {phoneLinks.map((link) => (
                <DropdownMenuItem key={link.href} asChild>
                  <Link href={link.href} prefetch={false}>
                    {link.label}
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={actions.openRename}>Rename</DropdownMenuItem>
          {signInAvailable && (
            <DropdownMenuItem onSelect={() => setSavePanel(isGuest ? "nudge" : "picker")}>{SAVE_TO_PROJECT_LABEL}</DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={openDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {actions.pending === "rename" && (
        <RenameDialog
          open
          itemType="document"
          currentTitle={title}
          onSave={actions.rename}
          onCancel={actions.closePending}
          submitting={actions.submitting}
        />
      )}
      {actions.pending === "delete" && (
        <ConfirmDeleteDialog
          open
          itemType="document"
          itemTitle={title}
          impact={impactQuery.data}
          onConfirm={actions.remove}
          onCancel={actions.closePending}
          submitting={actions.submitting}
        />
      )}
      {savePanel === "picker" && (
        <SaveToProjectDialog
          open
          onCancel={() => setSavePanel("none")}
          onSave={(projectId) => saveMutation.mutateAsync(projectId).then(() => undefined)}
          submitting={saveMutation.isPending}
        />
      )}
      {savePanel === "nudge" && (
        <div role="presentation" className="px-1">
          <SignInNudge context="save" onSignIn={() => router.push("/sign-in")} />
        </div>
      )}
    </>
  );
}
