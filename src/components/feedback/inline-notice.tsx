"use client";

import { isValidElement, type ReactNode } from "react";
import { Info, TriangleAlert } from "lucide-react";
import { useAnnounceOnMount } from "@/components/layout-primitives/live-region";
import { Alert, AlertDescription } from "@/components/ui/alert";

export interface InlineNoticeProps {
  tone?: "info" | "warning";
  children: ReactNode;
}

const ICON = { info: Info, warning: TriangleAlert } as const;

// A caller occasionally wraps part of its copy in an element (an action's own text inside a
// <strong>, for instance) — recursing into an element's own children is what keeps that copy in
// the announcement instead of silently dropping to an empty string.
function toPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toPlainText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return toPlainText(node.props.children);
  return "";
}

/**
 * A persistent inline notice for non-blocking, informational banners outside the
 * verified/approximate/not-found family. Mounts when its condition is true, unmounts when it
 * isn't — the caller owns the condition, this component owns only the rendering.
 */
export function InlineNotice({ tone = "info", children }: InlineNoticeProps) {
  const Icon = ICON[tone];
  useAnnounceOnMount(toPlainText(children), "polite");

  return (
    <Alert role="note">
      <Icon aria-hidden="true" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
