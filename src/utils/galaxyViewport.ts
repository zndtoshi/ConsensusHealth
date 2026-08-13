/**
 * Galaxy viewport measurement + camera fit helpers.
 * Keep container measurements authoritative so window fallbacks cannot
 * oversize the canvas and push sparse fits into the clipped bottom-right.
 */

export type Size = { w: number; h: number };

/** Prefer a real container rect; reject zero/invalid measurements. */
export function sizeFromContainerRect(rect: { width: number; height: number } | null | undefined): Size | null {
  if (!rect) return null;
  const rawW = Number(rect.width);
  const rawH = Number(rect.height);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW < 1 || rawH < 1) return null;
  return { w: Math.round(rawW), h: Math.round(rawH) };
}

/**
 * Translate so the world-space bbox center lands at the viewport center
 * after applying fitScale (user pan/zoom applied separately).
 */
export function fitTranslationForBounds(input: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cw: number;
  ch: number;
  fitScale: number;
}): { fitTx: number; fitTy: number; blobCx: number; blobCy: number } {
  const blobCx = (input.minX + input.maxX) / 2;
  const blobCy = (input.minY + input.maxY) / 2;
  return {
    blobCx,
    blobCy,
    fitTx: input.cw / 2 - blobCx * input.fitScale,
    fitTy: input.ch / 2 - blobCy * input.fitScale,
  };
}

/** Screen-space center of a fitted bbox (with optional user pan). */
export function fittedBoundsScreenCenter(input: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  fitScale: number;
  fitTx: number;
  fitTy: number;
  panX?: number;
  panY?: number;
}): { x: number; y: number } {
  const blobCx = (input.minX + input.maxX) / 2;
  const blobCy = (input.minY + input.maxY) / 2;
  const panX = Number(input.panX) || 0;
  const panY = Number(input.panY) || 0;
  return {
    x: blobCx * input.fitScale + input.fitTx + panX,
    y: blobCy * input.fitScale + input.fitTy + panY,
  };
}

export function defaultUserCamera() {
  return { scaleMul: 1, panX: 0, panY: 0 };
}

/**
 * Observe a mounted container element. Callers must pass the live DOM node
 * (not only a ref object) so observation rebinds when loading → graph mounts.
 */
export function observeContainerSize(
  el: Element,
  onSize: (size: Size) => void
): () => void {
  let cancelled = false;
  const measure = () => {
    if (cancelled) return;
    const next = sizeFromContainerRect(el.getBoundingClientRect());
    if (!next) return;
    onSize(next);
  };
  measure();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
  ro?.observe(el);
  if (typeof window !== "undefined") {
    window.addEventListener("resize", measure);
  }
  return () => {
    cancelled = true;
    ro?.disconnect();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", measure);
    }
  };
}
