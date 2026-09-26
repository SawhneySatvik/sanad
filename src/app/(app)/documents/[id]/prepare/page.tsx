import { PrepareClient } from "@/components/prepare/prepare-client";

/**
 * A thin server shell only: awaits the dynamic `params`/`searchParams` Next 16's App Router hands
 * back as Promises, then hands the resolved values to the client orchestrator, which owns every
 * fetch.
 */
export default async function PreparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lens?: string }>;
}) {
  const { id } = await params;
  const { lens } = await searchParams;
  return <PrepareClient documentId={id} initialLensParam={lens ?? null} />;
}
