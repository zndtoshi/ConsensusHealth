/**
 * Screen-space transform that lets a cached content snapshot stand in for a
 * re-render while the camera zooms.
 *
 * The snapshot was painted with world transform `screen = world * (fit.scale *
 * layer.scaleMul) + (fit.tx + layer.panX)`. The camera has since moved to
 * `screen = world * (fit.scale * cam.scaleMul) + (fit.tx + cam.panX)`. Because
 * the fit is frozen for the duration of a camera gesture, it cancels out and the
 * two are related by a plain scale-and-translate, so the bitmap can simply be
 * resampled. Pure panning yields k === 1 (a translation), which is the original
 * fast-pan behaviour.
 */
export type ZoomBlitCamera = { scaleMul: number; panX: number; panY: number };

export type ZoomBlitTransform = {
  /** Scale to apply to the snapshot bitmap. */
  k: number;
  /** Device-pixel translation to apply after scaling. */
  tXDev: number;
  tYDev: number;
};

/**
 * Resolve the snapshot→current scale factor, or null when the snapshot should
 * not be reused: too far in and it visibly softens, too far out and it stops
 * covering the viewport (it only holds what was on screen when captured).
 */
export function zoomBlitFactor(
  layerScaleMul: number,
  camScaleMul: number,
  minK: number,
  maxK: number
): number | null {
  if (!(layerScaleMul > 0) || !(camScaleMul > 0)) return null;
  const k = camScaleMul / layerScaleMul;
  if (!Number.isFinite(k) || k < minK || k > maxK) return null;
  return k;
}

/** Build the full device-pixel transform for blitting the snapshot. */
export function zoomBlitTransform(
  fitTx: number,
  fitTy: number,
  layer: ZoomBlitCamera,
  cam: ZoomBlitCamera,
  k: number,
  dpr: number
): ZoomBlitTransform {
  return {
    k,
    tXDev: (cam.panX - layer.panX * k + fitTx * (1 - k)) * dpr,
    tYDev: (cam.panY - layer.panY * k + fitTy * (1 - k)) * dpr,
  };
}

/**
 * Where a world point lands on screen (device pixels) after the blit. Used by
 * tests to prove the resampled bitmap agrees with a real render.
 */
export function projectViaBlit(
  world: number,
  fitScale: number,
  fitT: number,
  layerPan: number,
  layerScaleMul: number,
  t: ZoomBlitTransform,
  axis: "x" | "y",
  dpr: number
): number {
  // Position in the snapshot, in device pixels.
  const atCapture = (world * (fitScale * layerScaleMul) + fitT + layerPan) * dpr;
  return atCapture * t.k + (axis === "x" ? t.tXDev : t.tYDev);
}

/** Where a world point lands on screen (device pixels) in a real render. */
export function projectDirect(
  world: number,
  fitScale: number,
  fitT: number,
  camPan: number,
  camScaleMul: number,
  dpr: number
): number {
  return (world * (fitScale * camScaleMul) + fitT + camPan) * dpr;
}
