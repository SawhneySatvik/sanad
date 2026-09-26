"use client";

/**
 * The Findings/Ask segmented control (desktop, under DocumentHeader; reused inside the phone sheet
 * too, so a keyboard/AT user can switch tabs without closing and reopening it). Both panels stay
 * mounted at all times — only one is visually shown — so a long findings scroll or an in-progress
 * stream is never lost by switching.
 *
 * `TabsContent forceMount` is load-bearing, not a style choice: Radix's TabsTrigger always sets
 * `aria-controls` pointing at its own tabpanel id. A plain sibling `<div>` standing in for the
 * inactive panel (this file's earlier draft) leaves that id unresolved once the corresponding
 * TabsContent unmounts, which axe flags as a critical aria-valid-attr-value violation. forceMount
 * keeps both real tabpanels in the DOM; `data-[state=inactive]:hidden` is the only thing that hides
 * the inactive one, never removing it.
 */

import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FINDINGS_SEGMENT_LABEL, ASK_SEGMENT_LABEL } from "../copy";

export type WorkspaceSegment = "findings" | "ask";

export interface SegmentedFindingsAskProps {
  value: WorkspaceSegment;
  onChange: (segment: WorkspaceSegment) => void;
  findingsPanel: ReactNode;
  askPanel: ReactNode;
  className?: string;
}

export function SegmentedFindingsAsk({ value, onChange, findingsPanel, askPanel, className }: SegmentedFindingsAskProps) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as WorkspaceSegment)} className={`flex min-h-0 flex-1 flex-col ${className ?? ""}`}>
      <TabsList className="mx-4 mt-2 self-start">
        <TabsTrigger value="findings">{FINDINGS_SEGMENT_LABEL}</TabsTrigger>
        <TabsTrigger value="ask">{ASK_SEGMENT_LABEL}</TabsTrigger>
      </TabsList>
      {/* The gutter lives here, not inside FindingsPane itself: this same slot also renders
          NotReadyPanel/EmptyState (workspace-client.tsx's renderFindingsPane), which never wrap
          FindingsPane at all on those states — one padded ancestor is what gives every one of them
          the same inset, rather than three separate places each remembering to add it. */}
      <TabsContent value="findings" forceMount className="min-h-0 flex-1 overflow-y-auto px-4 py-2 data-[state=inactive]:hidden">
        {findingsPanel}
      </TabsContent>
      <TabsContent value="ask" forceMount className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        {askPanel}
      </TabsContent>
    </Tabs>
  );
}
