"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { ItemMenu } from "./item-menu";
import { RenameDialog } from "./rename-dialog";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";
import { renameLocalThread, deleteLocalThread } from "./local-threads";
import { expiresInHoursLabel, type RecentItem, type RecentItemType } from "./recent-items";
import { useRecents } from "./use-recents";

const LIST_KIND_BY_TYPE: Record<RecentItemType, "documents" | "comparisons" | "drafts" | "threads"> = {
  document: "documents",
  comparison: "comparisons",
  draft: "drafts",
  thread: "threads",
};

const API_PATH_BY_TYPE: Record<RecentItemType, string> = {
  document: "/api/documents",
  comparison: "/api/comparisons",
  draft: "/api/drafts",
  thread: "/api/threads",
};

const LIBRARY_FALLBACK_ROUTE: Record<RecentItemType, string> = {
  document: "/library",
  comparison: "/library",
  draft: "/library",
  thread: "/chat",
};

type PendingAction = { item: RecentItem; action: "rename" | "delete" };

/** Up to 20 rows across kinds, each a real link, with ItemMenu revealed on hover/focus. */
export function RecentsList() {
  const { items, isLoading } = useRecents();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const router = useRouter();

  function closePending() {
    setPending(null);
  }

  async function handleRename(title: string) {
    if (!pending) return;
    setSubmitting(true);
    try {
      if (pending.item.isLocal) {
        // renameLocalThread invalidates the shared local-threads store itself — useRecents' own
        // subscription re-renders this list without a separate refetch call here.
        renameLocalThread(pending.item.id, title);
      } else {
        await apiFetch(`${API_PATH_BY_TYPE[pending.item.itemType]}/${pending.item.id}`, {
          method: "PATCH",
          json: { title },
        });
        const kind = LIST_KIND_BY_TYPE[pending.item.itemType];
        void queryClient.invalidateQueries({ queryKey: [kind, "list"] });
        void queryClient.invalidateQueries({ queryKey: [kind, pending.item.id] });
      }
      toast.success("Renamed");
      closePending();
    } catch {
      toast.error("Couldn't rename this item.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!pending) return;
    setSubmitting(true);
    try {
      if (pending.item.isLocal) {
        deleteLocalThread(pending.item.id);
      } else {
        await apiFetch(`${API_PATH_BY_TYPE[pending.item.itemType]}/${pending.item.id}`, { method: "DELETE" });
        const kind = LIST_KIND_BY_TYPE[pending.item.itemType];
        void queryClient.invalidateQueries({ queryKey: [kind, "list"] });
      }
      toast.success("Deleted");
      if (pathname === pending.item.href) router.push(LIBRARY_FALLBACK_ROUTE[pending.item.itemType]);
      closePending();
    } catch {
      toast.error("Couldn't delete this item.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Recents</SidebarGroupLabel>
      <SidebarGroupContent>
        {isLoading && items.length === 0 ? (
          <div className="flex flex-col gap-2 px-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : items.length === 0 ? (
          <p className="mt-4 px-2 py-1.5 text-sm text-muted-foreground">Nothing here yet</p>
        ) : (
          <SidebarMenu>
            {items.map((item) => (
              <SidebarMenuItem key={`${item.itemType}-${item.id}`}>
                <SidebarMenuButton
                  asChild
                  isActive={pathname === item.href}
                  className="h-auto flex-col items-start gap-0.5 py-2"
                >
                  <Link href={item.href} aria-current={pathname === item.href ? "page" : undefined}>
                    <span className="w-full truncate text-sm">{item.title}</span>
                    {item.expiresAt && (
                      <span className="text-xs text-muted-foreground">{expiresInHoursLabel(item.expiresAt)}</span>
                    )}
                  </Link>
                </SidebarMenuButton>
                <ItemMenu
                  itemId={item.id}
                  itemType={item.itemType}
                  label={item.title}
                  onRename={() => setPending({ item, action: "rename" })}
                  onDelete={() => setPending({ item, action: "delete" })}
                />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>

      {pending?.action === "rename" && (
        <RenameDialog
          open
          itemType={pending.item.itemType}
          currentTitle={pending.item.title}
          onSave={handleRename}
          onCancel={closePending}
          submitting={submitting}
        />
      )}
      {pending?.action === "delete" && (
        <ConfirmDeleteDialog
          open
          itemType={pending.item.itemType}
          itemTitle={pending.item.title}
          onConfirm={handleDelete}
          onCancel={closePending}
          submitting={submitting}
        />
      )}
    </SidebarGroup>
  );
}
