/** Shared Canvas backing-store DPR cap (CSS size stays unchanged). */
export const MAX_CANVAS_DPR = 2;

/**
 * Resolve the canvas backing-store device pixel ratio.
 * Caps all browsers consistently; does not change CSS layout size.
 */
export function resolveCanvasDpr(
  devicePixelRatio: number = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  maxDpr: number = MAX_CANVAS_DPR
): number {
  const raw = Number(devicePixelRatio);
  const dpr = Number.isFinite(raw) && raw > 0 ? raw : 1;
  const max = Number.isFinite(maxDpr) && maxDpr > 0 ? maxDpr : MAX_CANVAS_DPR;
  return Math.min(dpr, max);
}

export type WrapperCanvasSize = {
  cssW: number;
  cssH: number;
  bitmapW: number;
  bitmapH: number;
  changed: boolean;
};

/**
 * Size a full-wrapper canvas so CSS matches the wrapper and the backing
 * bitmap equals CSS × resolved DPR. Avoids the default 300×150 store being
 * stretched across the viewport.
 */
export function syncWrapperCanvas(
  canvas: { width: number; height: number; style: { width: string; height: string } },
  cssWidth: number,
  cssHeight: number,
  dpr: number
): WrapperCanvasSize {
  const cssW = Math.max(1, Math.round(Number(cssWidth) || 1));
  const cssH = Math.max(1, Math.round(Number(cssHeight) || 1));
  const resolvedDpr = resolveCanvasDpr(dpr);
  const bitmapW = Math.max(1, Math.floor(cssW * resolvedDpr));
  const bitmapH = Math.max(1, Math.floor(cssH * resolvedDpr));
  const styleW = `${cssW}px`;
  const styleH = `${cssH}px`;
  const changed =
    canvas.width !== bitmapW ||
    canvas.height !== bitmapH ||
    canvas.style.width !== styleW ||
    canvas.style.height !== styleH;
  if (changed) {
    canvas.width = bitmapW;
    canvas.height = bitmapH;
    canvas.style.width = styleW;
    canvas.style.height = styleH;
  }
  return { cssW, cssH, bitmapW, bitmapH, changed };
}
