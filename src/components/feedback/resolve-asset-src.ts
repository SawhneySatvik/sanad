/**
 * The one seam this resolves through: once a real file lands at its manifest path under
 * public/assets/**, this is the one place that starts naming it — AssetPlaceholder itself doesn't
 * change. Deliberately never probes the network to check (an <img onError> fallback would fire a
 * real request on every render, tripping the e2e isolation check that aborts any non-localhost
 * request); until this function names a path, every AssetPlaceholder renders its placeholder box.
 */
export function resolveAssetSrc(assetId: string): string | null {
  void assetId;
  return null;
}
