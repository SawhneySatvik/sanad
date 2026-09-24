/**
 * A minimal Next App Router context for component tests that call useRouter()/usePathname() but
 * never actually navigate. useRouter() throws "invariant expected app router to be mounted" with no
 * AppRouterContext ancestor at all (confirmed against next/dist/client/components/navigation.js);
 * usePathname() is milder (a bare useContext, defaulting to null), but a component under test may
 * still want a specific value to assert against, so this stub supplies both from one wrapper.
 */

import type { ReactNode } from "react";
import { vi } from "vitest";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

export function fakeAppRouter(overrides: Partial<AppRouterInstance> = {}): AppRouterInstance {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    ...overrides,
  } as AppRouterInstance;
}

export function NextRouterStub({
  children,
  pathname = "/",
  router = fakeAppRouter(),
}: {
  children: ReactNode;
  pathname?: string;
  router?: AppRouterInstance;
}) {
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={pathname}>{children}</PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}
