import type { ReactNode } from "react";

/** No AppShell here — the landing page is a cold visitor's first frame, not a signed-in workspace. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-1 flex-col">{children}</div>;
}
