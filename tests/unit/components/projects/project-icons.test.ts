import { describe, expect, it } from "vitest";
import { FolderKanban, House } from "lucide-react";
import { projectIcon, PROJECT_ICON_NAMES } from "@/components/projects/project-icons";

describe("projectIcon", () => {
  it("resolves a confirmed name to its icon", () => {
    expect(projectIcon("House")).toBe(House);
  });

  it("falls back to FolderKanban for null, undefined or an unrecognised stored string", () => {
    expect(projectIcon(null)).toBe(FolderKanban);
    expect(projectIcon(undefined)).toBe(FolderKanban);
    expect(projectIcon("not-a-real-icon")).toBe(FolderKanban);
  });

  it("exposes exactly the 7 confirmed names", () => {
    expect(PROJECT_ICON_NAMES).toHaveLength(7);
    expect(PROJECT_ICON_NAMES).toContain("FolderKanban");
  });
});
