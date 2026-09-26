import { WorkspaceClient } from "@/components/workspace/workspace-client";

/**
 * The analysis workspace — the anchor surface every other screen's visual world inherits. A thin
 * server shell only: it awaits the dynamic `params`/`searchParams` (Next 16's App Router hands both
 * back as Promises) and hands the resolved values to the client orchestrator, which owns every
 * fetch: these screens fetch nothing server-side, all data comes from client-side TanStack Query.
 */
export default async function DocumentWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lens?: string }>;
}) {
  const { id } = await params;
  const { lens } = await searchParams;
  return <WorkspaceClient documentId={id} initialLensParam={lens ?? null} />;
}
