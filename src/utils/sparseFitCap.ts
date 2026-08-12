/**
 * Cap automatic canvas fit scale when a galaxy has very few avatars so one
 * account does not fill most of the viewport. Dense galaxies stay uncapped.
 */

export type SparseFitCapInput = {
  fitScale: number;
  /** Largest ordinary node side in world units (before selection FX). */
  maxNodeSide: number;
  visibleNodeCount: number;
  viewportWidth: number;
  viewportHeight: number;
};

/** Soft target for the largest ordinary avatar on screen (px), before zoom/selection. */
export function sparseMaxOnScreenAvatarPx(nodeCount: number, shortViewportSide: number): number {
  const n = Math.max(0, Math.floor(nodeCount));
  const narrow = shortViewportSide < 720;
  const one = narrow ? 112 : 140;
  const few = narrow ? 96 : 120;
  const mid = narrow ? 88 : 108;
  // Large enough that normal dense-galaxy fit remains the binding constraint.
  const uncapped = Math.max(shortViewportSide * 0.72, mid + 40);

  if (n <= 0) return uncapped;
  if (n === 1) return one;
  if (n <= 4) {
    const t = (n - 1) / 3;
    return one + (few - one) * t;
  }
  if (n <= 10) {
    const t = (n - 4) / 6;
    // Ease from mid-band toward uncapped so 5–10 blend into normal fit.
    const start = few + (mid - few) * 0.35;
    return start + (uncapped - start) * t;
  }
  return uncapped;
}

/**
 * Returns fitScale limited so maxNodeSide * scale does not exceed the sparse
 * on-screen target. Never increases scale.
 */
export function applySparseFitCap(input: SparseFitCapInput): number {
  const fitScale = Number(input.fitScale);
  const maxNodeSide = Number(input.maxNodeSide);
  if (!Number.isFinite(fitScale) || fitScale <= 0) return fitScale;
  if (!Number.isFinite(maxNodeSide) || maxNodeSide <= 0) return fitScale;

  const shortSide = Math.max(1, Math.min(Number(input.viewportWidth) || 1, Number(input.viewportHeight) || 1));
  const maxPx = sparseMaxOnScreenAvatarPx(input.visibleNodeCount, shortSide);
  if (!Number.isFinite(maxPx) || maxPx <= 0) return fitScale;

  const capped = maxPx / maxNodeSide;
  return Math.min(fitScale, capped);
}

/** Selection growth should stay near the same sparse comfort band. */
export function sparseSelectedTargetSide(
  nodeCount: number,
  shortViewportSide: number,
  fitScale: number,
  fallbackWorldSide = 70
): number {
  const scale = Number(fitScale);
  if (!Number.isFinite(scale) || scale <= 0) return fallbackWorldSide;
  const maxPx = sparseMaxOnScreenAvatarPx(nodeCount, shortViewportSide) * 1.15;
  return Math.min(fallbackWorldSide, maxPx / scale);
}
