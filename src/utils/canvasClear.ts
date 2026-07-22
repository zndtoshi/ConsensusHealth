/**
 * HiDPI-safe canvas clearing. Always clear the full bitmap in device pixels
 * with an identity transform so previous frames cannot leave translucent trails.
 */

export type Canvas2D = {
  save: () => void;
  restore: () => void;
  setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  clearRect: (x: number, y: number, w: number, h: number) => void;
  globalAlpha: number;
  globalCompositeOperation: string;
};

export type CanvasLike = {
  width: number;
  height: number;
};

/**
 * Fully clears the canvas bitmap regardless of the current transform, alpha,
 * or composite mode. Prefer this over `clearRect(0, 0, cssW, cssH)` under a
 * DPR transform (or worse, under a leftover world transform).
 */
export function clearCanvasBitmap(ctx: Canvas2D, canvas: CanvasLike): void {
  const w = Math.max(0, canvas.width | 0);
  const h = Math.max(0, canvas.height | 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
}

/**
 * True when a CSS-pixel clearRect under the current transform would leave
 * uncleared device pixels on a HiDPI canvas (the Chrome trail failure mode).
 */
export function cssPixelClearWouldMissBitmap(opts: {
  canvasWidth: number;
  canvasHeight: number;
  clearWidthCss: number;
  clearHeightCss: number;
  transformA: number;
  transformD: number;
}): boolean {
  const coveredW = opts.clearWidthCss * opts.transformA;
  const coveredH = opts.clearHeightCss * opts.transformD;
  // Identity transform on a DPR-sized bitmap: covers only a fraction.
  // World-scale transforms can cover even less or the wrong region.
  return coveredW + 0.5 < opts.canvasWidth || coveredH + 0.5 < opts.canvasHeight;
}
