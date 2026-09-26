"use client";

/**
 * A Popover on desktop, a BottomSheet on phone — every other dialog here stays a centred Dialog at
 * both viewports. Fully controlled (open/onOpenChange) rather than trigger-driven: the caller's own
 * ItemMenu already owns the "Save to project" click (see library-row-actions.tsx), so this component
 * only needs an anchor to position against, via Radix Popover's Anchor (not its Trigger).
 *
 * A plain list of buttons, not a searchable Command/Select, even for a caller with many projects —
 * a deliberately simpler always-plain-list form for every count, rather than switching UI once a
 * project count crosses some threshold.
 */

import { type ReactNode, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetchJson, ApiError } from "@/lib/api";
import { useIsMobile } from "@/hooks/use-mobile";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProjectsListOutput } from "@/shared/contracts/projects";
import type { z } from "zod";
import { projectIcon } from "./project-icons";

type ProjectsList = z.infer<typeof ProjectsListOutput>;

const NAME_MAX = 120;

function ProjectPickerList({ onSelect }: { onSelect: (projectId: string) => Promise<void> }) {
  const queryClient = useQueryClient();
  const projects = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => apiFetchJson<ProjectsList>("/api/projects"),
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [submittingCreate, setSubmittingCreate] = useState(false);

  async function pick(id: string) {
    setPendingId(id);
    try {
      await onSelect(id);
    } finally {
      setPendingId(null);
    }
  }

  async function submitCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Give it a name.");
      return;
    }
    if (trimmed.length > NAME_MAX) {
      setNameError(`${NAME_MAX} characters or fewer.`);
      return;
    }
    setSubmittingCreate(true);
    setNameError(null);
    try {
      const project = await apiFetchJson<{ id: string }>("/api/projects", { method: "POST", json: { name: trimmed } });
      void queryClient.invalidateQueries({ queryKey: ["projects", "list"] });
      setCreating(false);
      setName("");
      await pick(project.id);
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmittingCreate(false);
    }
  }

  if (creating) {
    return (
      <div className="flex flex-col gap-2 p-1">
        <Label htmlFor="project-picker-new-name">Name</Label>
        <Input
          id="project-picker-new-name"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
          maxLength={NAME_MAX + 20}
          aria-invalid={!!nameError}
        />
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={submittingCreate} onClick={() => void submitCreate()}>
            Create
          </Button>
        </div>
      </div>
    );
  }

  const projectList = projects.data?.projects ?? [];

  return (
    <div className="flex flex-col gap-0.5 p-1" role="listbox" aria-label="Projects">
      {projects.isLoading && <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading projects…</p>}
      {projectList.map((project) => {
        const Icon = projectIcon(project.icon);
        return (
          <button
            key={project.id}
            type="button"
            role="option"
            aria-selected={false}
            disabled={pendingId !== null}
            onClick={() => void pick(project.id)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60"
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{project.name}</span>
            {pendingId === project.id && <span className="ml-auto shrink-0 text-xs text-muted-foreground">Saving…</span>}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="flex items-center gap-2 rounded-md border-t border-border px-2 py-1.5 pt-2.5 text-left text-sm text-foreground hover:bg-accent"
      >
        + New project
      </button>
    </div>
  );
}

export interface ProjectPickerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The row/card content the popover anchors against on desktop — rendered as-is on phone (no anchor needed for a sheet). */
  anchor: ReactNode;
  onSelect(projectId: string): Promise<void>;
}

export function ProjectPicker({ open, onOpenChange, anchor, onSelect }: ProjectPickerProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <>
        {anchor}
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            side="bottom"
            className="flex max-h-[70dvh] flex-col rounded-t-xl border-t border-border p-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="border-b border-border">
              <SheetTitle>Save to project</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ProjectPickerList onSelect={onSelect} />
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent align="end" className="w-64">
        <ProjectPickerList onSelect={onSelect} />
      </PopoverContent>
    </Popover>
  );
}
