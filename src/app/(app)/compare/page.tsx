import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ComparePickerClient } from "@/components/compare/picker/compare-picker-client";

/**
 * The Compare picker. A thin server shell: ComparePickerClient owns every fetch and reads `?a=`
 * itself via useSearchParams, which Next requires a Suspense boundary for.
 */
export default function ComparePickerPage() {
  return (
    <Suspense fallback={<Skeleton className="m-4 h-64" />}>
      <ComparePickerClient />
    </Suspense>
  );
}
