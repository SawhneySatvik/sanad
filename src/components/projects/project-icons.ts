/**
 * The 7 confirmed lucide-react icon names a project may carry — an unrecognised stored `icon`
 * string (future data, a different client) falls back to FolderKanban, never a broken render.
 * Rendered in plain ink colour everywhere; `ProjectOutput.color` is read by nothing this UI writes.
 */
import { Briefcase, FileText, FolderKanban, Handshake, House, Lock, Shield, type LucideIcon } from "lucide-react";

export const PROJECT_ICON_NAMES = ["FolderKanban", "House", "Briefcase", "Lock", "Shield", "Handshake", "FileText"] as const;
export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

export const PROJECT_ICON_LABELS: Record<ProjectIconName, string> = {
  FolderKanban: "Folder",
  House: "House",
  Briefcase: "Briefcase",
  Lock: "Lock",
  Shield: "Shield",
  Handshake: "Handshake",
  FileText: "Document",
};

const ICONS: Record<ProjectIconName, LucideIcon> = {
  FolderKanban,
  House,
  Briefcase,
  Lock,
  Shield,
  Handshake,
  FileText,
};

export function projectIcon(icon: string | null | undefined): LucideIcon {
  if (icon && icon in ICONS) return ICONS[icon as ProjectIconName];
  return FolderKanban;
}
