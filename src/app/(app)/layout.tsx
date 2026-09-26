import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";

/** Every (app) route's shared chrome — see src/components/shell/app-shell.tsx for what it mounts. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-full flex-1 flex-col"
    >
      <AppShell>{children}</AppShell>
    </div>
  );
}
