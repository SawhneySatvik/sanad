import { DraftNewClient } from "@/components/draft/draft-new-client";

/**
 * A thin server shell only: awaits the dynamic `searchParams` Next 16's App Router hands back as a
 * Promise, then hands the resolved `grounding` value to the client orchestrator, which owns every
 * fetch.
 */
export default async function NewDraftPage({ searchParams }: { searchParams: Promise<{ grounding?: string }> }) {
  const { grounding } = await searchParams;
  return <DraftNewClient initialGroundingDocumentId={grounding ?? null} />;
}
