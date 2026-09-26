import { DraftClient } from "@/components/draft/draft-client";

/**
 * A thin server shell only: awaits the dynamic `params` Next 16's App Router hands back as a
 * Promise, then hands the resolved id to the client orchestrator, which owns every fetch.
 */
export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DraftClient draftId={id} />;
}
