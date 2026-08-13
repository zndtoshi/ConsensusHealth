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
  /**
   * Active user-camera multiplier (`cam.scaleMul`). Cap is enforced on the
   * final screen-space product `maxNodeSide * fitScale * userScaleMul`.
   */
  userScaleMul?: number;
};

/**
 * Soft target for the largest ordinary avatar on screen (CSS px), before zoom/selection.
 * One-user galaxies stay modest (~64–90px on desktop) including stance border.
 */
export function sparseMaxOnScreenAvatarPx(nodeCount: number, shortViewportSide: number): number {
  const n = Math.max(0, Math.floor(nodeCount));
  const narrow = shortViewportSide < 720;
  // Desktop one-user ~78px; mobile ~56px. Includes room for a thin stance ring.
  const one = narrow ? 56 : 78;
  const few = narrow ? 52 : 70;
  const mid = narrow ? 60 : 86;
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
    const start = few + (mid - few) * 0.35;
    return start + (uncapped - start) * t;
  }
  return uncapped;
}

/**
 * Shrink stance-glow sprite blur/pad in sparse scenes so the halo does not
 * read several times larger than the capped portrait.
 */
export function sparseGlowFootprintMultiplier(nodeCount: number): number {
  const n = Math.max(0, Math.floor(nodeCount));
  if (n <= 1) return 0.32;
  if (n <= 4) return 0.42;
  if (n <= 10) return 0.68;
  return 1;
}

/**
 * Returns fitScale limited so
 * `maxNodeSide * fitScale * userScaleMul` does not exceed the sparse on-screen
 * target. Never increases scale. Translation should be derived from the returned
 * fitScale so the galaxy stays centered after the cap.
 */
export function applySparseFitCap(input: SparseFitCapInput): number {
  const fitScale = Number(input.fitScale);
  const maxNodeSide = Number(input.maxNodeSide);
  if (!Number.isFinite(fitScale) || fitScale <= 0) return fitScale;
  if (!Number.isFinite(maxNodeSide) || maxNodeSide <= 0) return fitScale;

  const shortSide = Math.max(1, Math.min(Number(input.viewportWidth) || 1, Number(input.viewportHeight) || 1));
  const maxPx = sparseMaxOnScreenAvatarPx(input.visibleNodeCount, shortSide);
  if (!Number.isFinite(maxPx) || maxPx <= 0) return fitScale;

  const rawMul = Number(input.userScaleMul);
  const userScaleMul = Number.isFinite(rawMul) && rawMul > 0 ? rawMul : 1;
  // Cap effective scale, then convert back to fitScale for stable centering.
  const cappedFit = maxPx / maxNodeSide / userScaleMul;
  return Math.min(fitScale, cappedFit);
}

/** Final screen-space avatar side after fit × user camera multiplier. */
export function sparseEffectiveAvatarPx(
  maxNodeSide: number,
  fitScale: number,
  userScaleMul = 1
): number {
  const side = Number(maxNodeSide);
  const fit = Number(fitScale);
  const mul = Number(userScaleMul);
  if (!Number.isFinite(side) || !Number.isFinite(fit)) return NaN;
  const safeMul = Number.isFinite(mul) && mul > 0 ? mul : 1;
  return side * fit * safeMul;
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
  const maxPx = sparseMaxOnScreenAvatarPx(nodeCount, shortViewportSide) * 1.12;
  return Math.min(fallbackWorldSide, maxPx / scale);
}
