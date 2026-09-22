import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssetPlaceholder } from "./asset-placeholder";

export interface EmptyStateProps {
  heading: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  /** At most one of icon/asset — a bare heading-only empty state commissions neither on purpose. */
  icon?: LucideIcon;
  asset?: { id: string; ratio: string };
  /** So the rendered heading can match the surrounding hierarchy level — this component has no way to know its own position in a caller's page outline otherwise. */
  headingLevel?: 2 | 3;
}

/** A reusable empty state that teaches the interface rather than saying "nothing here." */
export function EmptyState({ heading, body, action, icon: Icon, asset, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";

  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      {Icon && <Icon aria-hidden="true" className="size-8 text-muted-faint" />}
      {asset && <AssetPlaceholder assetId={asset.id} ratio={asset.ratio} label={heading} sizePx={{ w: 240 }} />}
      <Heading className="font-display text-lg font-medium text-foreground">{heading}</Heading>
      {body && <p className="max-w-sm text-sm text-muted-foreground">{body}</p>}
      {action && (
        <Button variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
