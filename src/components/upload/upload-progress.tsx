"use client";

/**
 * The two network phases with visible progress: a determinate PUT (real byte progress, no
 * easing — it must track truth) and an indeterminate analyse pulse. The "requesting-target" step
 * and "done" state have no progress UI of their own — this component only ever renders these two.
 * The attachment row (file icon + filename) is optional — this component's own unit tests exercise
 * the bar in isolation, with no file behind it at all.
 */

import { FileText } from "lucide-react";
import { Progress as ProgressPrimitive } from "radix-ui";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import { PHASE_LABEL } from "./copy";
import type { UploadFlowFileMeta } from "./use-upload-flow";

export interface UploadProgressProps {
  phase: "uploading" | "analyzing";
  /** Real XMLHttpRequest.upload.onprogress value, 0-100 — required for "uploading", ignored for "analyzing". */
  percent?: number;
  fileMeta?: UploadFlowFileMeta | null;
}

/** "Uploading · 42%" during the determinate phase, the fixed analysing label otherwise — the one
 * stage label this row ever shows, never a second competing string. */
function stageLabel(phase: "uploading" | "analyzing", clampedPercent: number): string {
  return phase === "analyzing" ? PHASE_LABEL.analyzing : `Uploading · ${clampedPercent}%`;
}

// Scoped to this component rather than a shared globals.css keyframe, since no other component
// needs it. prefers-reduced-motion swaps it for a static, unanimated label instead.
const PULSE_STYLE = `
@keyframes upload-progress-analyzing-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.upload-progress-analyzing-pulse { animation: upload-progress-analyzing-pulse 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .upload-progress-analyzing-pulse { animation: none; opacity: 1; }
}
`;

export function UploadProgress({ phase, percent, fileMeta }: UploadProgressProps) {
  const isAnalyzing = phase === "analyzing";
  const clampedPercent = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  const label = stageLabel(phase, clampedPercent);

  // Announced once at phase start, not per tick — the determinate phase's own aria-valuenow
  // changes are the progressbar role's job, not a second live-region text stream.
  useAnnounceOnMount(isAnalyzing ? PHASE_LABEL.analyzing : "", "polite");

  return (
    <div className="flex flex-col gap-2">
      {fileMeta && (
        <div className="flex items-center gap-2 text-sm text-foreground">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate font-medium">{fileMeta.filename}</span>
        </div>
      )}
      {isAnalyzing && <style>{PULSE_STYLE}</style>}
      <ProgressPrimitive.Root
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={isAnalyzing ? undefined : 100}
        aria-valuenow={isAnalyzing ? undefined : clampedPercent}
        aria-valuetext={isAnalyzing ? "Analysing" : undefined}
        data-phase={phase}
        className={`relative h-1 w-full overflow-hidden rounded-full bg-muted ${isAnalyzing ? "upload-progress-analyzing-pulse" : ""}`}
      >
        <ProgressPrimitive.Indicator
          className="block h-full bg-primary"
          style={{ width: isAnalyzing ? "100%" : `${clampedPercent}%` }}
        />
      </ProgressPrimitive.Root>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
