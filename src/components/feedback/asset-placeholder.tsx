import { resolveAssetSrc } from "./resolve-asset-src";

export interface AssetPlaceholderProps {
  /** The commissioned raster art's own catalogue id, e.g. "empty-library" — also names the placeholder caption. */
  assetId: string;
  /** A CSS aspect-ratio value, e.g. "1 / 1", "16 / 9". */
  ratio: string;
  label: string;
  /** `h` is optional so a caller can size by width alone, leaving `aspectRatio` to compute the height — setting both defeats `aspect-ratio` entirely (the CSS property is ignored once both dimensions are fixed). */
  sizePx?: { w: number; h?: number };
}

/** A labelled placeholder at an asset's final ratio, until delivered art lands. */
export function AssetPlaceholder({ assetId, ratio, label, sizePx }: AssetPlaceholderProps) {
  const src = resolveAssetSrc(assetId);
  const style = { aspectRatio: ratio, width: sizePx?.w, height: sizePx?.h };

  if (src) {
    // eslint-disable-next-line @next/next/no-img-element -- unreached until resolveAssetSrc names a real path; revisit next/image then
    return <img src={src} alt="" role="img" aria-label={label} style={style} className="w-full rounded-md object-cover" />;
  }

  return (
    <div
      role="img"
      aria-label={label}
      style={style}
      className="flex w-full items-center justify-center rounded-md border border-dashed border-border bg-muted p-4 text-center text-xs text-muted-foreground"
    >
      {`Placeholder — final art pending (${assetId})`}
    </div>
  );
}
