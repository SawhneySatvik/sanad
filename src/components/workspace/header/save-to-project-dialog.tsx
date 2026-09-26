"use client";

/**
 * The signed-in half of "Save to project" (the guest half is SignInNudge, context: "save").
 * `ProjectPicker` belongs to the library/projects surface (src/components/projects/**); this is a
 * deliberately minimal control scoped to this menu's own needs — a single Select fed by
 * GET /api/projects — since building the full picker (search, a phone sheet, create-new-inline) is
 * out of scope here.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetchJson } from "@/lib/api";
import type { ProjectsListOutput } from "@/shared/contracts/projects";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface SaveToProjectDialogProps {
  open: boolean;
  onCancel: () => void;
  onSave: (projectId: string) => Promise<void>;
  submitting?: boolean;
}

export function SaveToProjectDialog({ open, onCancel, onSave, submitting }: SaveToProjectDialogProps) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const projects = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => apiFetchJson<ProjectsListOutput>("/api/projects"),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save to project</DialogTitle>
        </DialogHeader>
        <Select value={projectId ?? undefined} onValueChange={setProjectId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={projects.isLoading ? "Loading projects…" : "Choose a project"} />
          </SelectTrigger>
          <SelectContent>
            {(projects.data?.projects ?? []).map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={!projectId || submitting} onClick={() => projectId && onSave(projectId)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
