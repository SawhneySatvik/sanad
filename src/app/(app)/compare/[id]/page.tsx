import { CompareView } from "@/components/compare/compare-view";

/**
 * The comparison detail screen — a thin server shell only: it awaits the dynamic `params` (Next
 * 16's App Router hands it back as a Promise) and hands the resolved id to the client orchestrator,
 * which owns every fetch.
 */
export default async function ComparisonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CompareView comparisonId={id} />;
}
