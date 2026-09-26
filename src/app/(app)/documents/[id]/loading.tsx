import { Skeleton } from "@/components/ui/skeleton";

/** Next's own route-segment loading boundary — covers the brief window before page.tsx's awaited params/searchParams resolve; WorkspaceClient owns every later loading state (the GET itself). */
export default function DocumentWorkspaceLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
