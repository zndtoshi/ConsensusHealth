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
