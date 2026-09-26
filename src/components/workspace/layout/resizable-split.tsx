"use client";

/**
 * The desktop workspace split: document column (left) / right pane, persisted to localStorage under
 * exactly `saboot:layout:workspace-split` (the saboot:layout:* namespace so "Delete all my data"
 * can clear it — src/components/shell/clear-saboot-storage.ts's own prefix scan).
 *
 * react-resizable-panels' own `useDefaultLayout` hook (its built-in persistence helper) always
 * writes under its own `react-resizable-panels:<id>` prefix — confirmed by reading
 * the installed package's compiled source, not assumed — so it cannot produce this exact key. This
 * file persists the layout itself instead: read once on mount (client-only, since localStorage
 * doesn't exist during SSR), write on every user-driven layout change.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator, type Layout } from "react-resizable-panels";
import { WORKSPACE_HEIGHT_CLASS } from "./workspace-height";

export const WORKSPACE_SPLIT_STORAGE_KEY = "saboot:layout:workspace-split";

const DOCUMENT_PANEL_ID = "document";
const RIGHT_PANEL_ID = "right-pane";

function readPersistedLayout(): Layout | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_SPLIT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Layout)[DOCUMENT_PANEL_ID] === "number" &&
      typeof (parsed as Layout)[RIGHT_PANEL_ID] === "number"
    ) {
      return parsed as Layout;
    }
  } catch {
    // A corrupted/foreign value at this key falls back to the default layout below.
  }
  return undefined;
}

export interface ResizableWorkspaceSplitProps {
  documentPane: ReactNode;
  rightPane: ReactNode;
}

/**
 * Sidebar (264/56px, independent — AppShell's own chrome) sits outside this component; this is only
 * the document-column / right-pane split, default ~65/35, document column min 420px, right pane min
 * 320px / max 560px expressed as percentages of this group alone.
 */
export function ResizableWorkspaceSplit({ documentPane, rightPane }: ResizableWorkspaceSplitProps) {
  // Lazily read once per mount (not per render) — reading localStorage during render on every
  // re-render would be wasted work for a value that only ever changes via this component's own
  // onLayoutChanged below.
  const [defaultLayout] = useState<Layout | undefined>(readPersistedLayout);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onLayoutChanged = useCallback((layout: Layout) => {
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      try {
        window.localStorage.setItem(WORKSPACE_SPLIT_STORAGE_KEY, JSON.stringify(layout));
      } catch {
        // Storage full/blocked (private browsing) — the split still works for this session, it just
        // won't be remembered next time.
      }
    }, 150);
  }, []);

  return (
    // The extra wrapper is load-bearing, not decoration: Group's own root div forces
    // `style={{ height: "100%", ... }}` inline (confirmed by reading the installed package's
    // compiled source, not assumed) — an inline style always beats a Tailwind height class
    // regardless of specificity tricks, so putting WORKSPACE_HEIGHT_CLASS on Group itself does
    // nothing. `height: 100%` needs its own direct parent to already have a definite height to
    // resolve against; AppShell's own content wrapper gives this route exactly that (see
    // workspace-height.ts), so without this wrapper still consuming it via `h-full` one level down,
    // Group (and everything inside it) would just grow to fit content and the whole page would
    // scroll instead — red-proven against a real capture: the pinned composer measured ~8000px down
    // an unbounded page before this wrapper existed.
    <div className={`flex ${WORKSPACE_HEIGHT_CLASS}`}>
      <Group orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <Panel id={DOCUMENT_PANEL_ID} minSize={420} className="flex min-h-0 min-w-[420px] flex-col">
          {documentPane}
        </Panel>
        <Separator
          id="workspace-split-handle"
          className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring focus-visible:bg-ring focus-visible:outline-none"
        />
        <Panel id={RIGHT_PANEL_ID} defaultSize={420} minSize={320} maxSize={560} className="flex min-h-0 min-w-[320px] max-w-[560px] flex-col">
          {rightPane}
        </Panel>
      </Group>
    </div>
  );
}
