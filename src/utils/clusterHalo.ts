import { CLUSTER_HALO_ADMIN_HANDLE, ENABLE_CLUSTER_HALO } from "../config/clusterHalo.js";

export type ClusterHaloStance = "against" | "neutral" | "approve";

export type ClusterBounds = {
  cx: number;
  cy: number;
  width: number;
  height: number;
};

export type ClusterHaloSmoothState = Partial<
  Record<ClusterHaloStance, { cx: number; cy: number; radius: number }>
>;

export const CLUSTER_HALO_GRADIENTS: Record<
  ClusterHaloStance,
  { center: string; middle: string; edge: string }
> = {
  against: {
    center: "rgba(255, 40, 40, 0.14)",
    middle: "rgba(255, 40, 40, 0.06)",
    edge: "rgba(255, 40, 40, 0)",
  },
  neutral: {
    center: "rgba(255, 255, 255, 0.08)",
    middle: "rgba(180, 200, 255, 0.04)",
    edge: "rgba(180, 200, 255, 0)",
  },
  approve: {
    center: "rgba(40, 255, 120, 0.14)",
    middle: "rgba(40, 255, 120, 0.06)",
    edge: "rgba(40, 255, 120, 0)",
  },
};

export const CLUSTER_HALO_STANCES: readonly ClusterHaloStance[] = ["against", "neutral", "approve"];

/** Breath period + phase offset per stance (6–9s, staggered). */
export const CLUSTER_HALO_BREATH: Record<
  ClusterHaloStance,
  { periodMs: number; phaseOffsetMs: number }
> = {
  against: { periodMs: 7800, phaseOffsetMs: 0 },
  neutral: { periodMs: 8400, phaseOffsetMs: 2200 },
  approve: { periodMs: 6900, phaseOffsetMs: 4100 },
};

export const CLUSTER_HALO_RADIUS_SCALE = 1.32;
export const CLUSTER_HALO_SMOOTHING = 0.14;
export const CLUSTER_HALO_RADIUS_BUCKET_PX = 12;

function normalizeHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export function shouldShowClusterHalo(opts?: {
  enabled?: boolean;
  authenticatedHandle?: string | null;
}): boolean {
  const enabled = opts?.enabled ?? ENABLE_CLUSTER_HALO;
  if (enabled) return true;
  return normalizeHandle(opts?.authenticatedHandle) === CLUSTER_HALO_ADMIN_HANDLE;
}

export function computeClusterBounds(
  nodes: ReadonlyArray<{ x: number; y: number; side: number }>,
  stance: ClusterHaloStance,
  resolveStance: (node: { x: number; y: number; side: number }) => string
): ClusterBounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const n of nodes) {
    if (resolveStance(n) !== stance) continue;
    const half = Math.max(3, Number(n.side) || 12) / 2;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    minX = Math.min(minX, n.x - half);
    maxX = Math.max(maxX, n.x + half);
    minY = Math.min(minY, n.y - half);
    maxY = Math.max(maxY, n.y + half);
    count += 1;
  }

  if (!count || !Number.isFinite(minX)) return null;

  const width = Math.max(24, maxX - minX);
  const height = Math.max(24, maxY - minY);
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width,
    height,
  };
}

/** Halo radius in world px (~1.3× cluster span). */
export function computeClusterHaloRadius(bounds: ClusterBounds): number {
  const span = Math.max(bounds.width, bounds.height, 48);
  return span * 0.5 * CLUSTER_HALO_RADIUS_SCALE;
}

export function bucketClusterHaloRadius(radius: number): number {
  const bucket = CLUSTER_HALO_RADIUS_BUCKET_PX;
  return Math.max(bucket * 2, Math.round(radius / bucket) * bucket);
}

/** Smooth sine breath between 92% and 100% opacity. */
export function clusterHaloBreathAlpha(stance: ClusterHaloStance, nowMs: number): number {
  const cfg = CLUSTER_HALO_BREATH[stance];
  const phase = ((nowMs + cfg.phaseOffsetMs) % cfg.periodMs) / cfg.periodMs;
  const wave = Math.sin(phase * Math.PI * 2);
  return 0.96 + wave * 0.04;
}

export function createClusterHaloSprite(stance: ClusterHaloStance, radius: number): HTMLCanvasElement {
  const r = Math.max(16, Math.round(radius));
  const size = r * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return canvas;

  const stops = CLUSTER_HALO_GRADIENTS[stance];
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, stops.center);
  grad.addColorStop(0.42, stops.middle);
  grad.addColorStop(1, stops.edge);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return canvas;
}

export function smoothClusterHaloState(
  prev: ClusterHaloSmoothState,
  stance: ClusterHaloStance,
  target: { cx: number; cy: number; radius: number },
  smoothing = CLUSTER_HALO_SMOOTHING
): { cx: number; cy: number; radius: number } {
  const cur = prev[stance];
  if (!cur) return { ...target };
  return {
    cx: cur.cx + (target.cx - cur.cx) * smoothing,
    cy: cur.cy + (target.cy - cur.cy) * smoothing,
    radius: cur.radius + (target.radius - cur.radius) * smoothing,
  };
}

/** Snaps halo centers to current cluster bounds (used after intro graph unfreeze). */
export function snapClusterHaloState(
  nodes: ReadonlyArray<{ x: number; y: number; side: number }>,
  resolveStance: (node: { x: number; y: number; side: number }) => string
): ClusterHaloSmoothState {
  const next: ClusterHaloSmoothState = {};
  for (const stance of CLUSTER_HALO_STANCES) {
    const bounds = computeClusterBounds(nodes, stance, resolveStance);
    if (!bounds) continue;
    next[stance] = {
      cx: bounds.cx,
      cy: bounds.cy,
      radius: computeClusterHaloRadius(bounds),
    };
  }
  return next;
}

/**
 * Draw ambient cluster halos in world space (call inside translate/scale).
 * One cached radial sprite per stance; only globalAlpha changes per frame.
 */
export function drawClusterHalos(
  ctx: CanvasRenderingContext2D,
  nodes: ReadonlyArray<{ x: number; y: number; side: number }>,
  resolveStance: (node: { x: number; y: number; side: number }) => string,
  nowMs: number,
  spriteCache: Map<string, HTMLCanvasElement>,
  smoothState: ClusterHaloSmoothState,
  opts?: { freeze?: boolean }
): ClusterHaloSmoothState {
  const nextSmooth: ClusterHaloSmoothState = { ...smoothState };

  for (const stance of CLUSTER_HALO_STANCES) {
    let smoothed = nextSmooth[stance];
    if (!opts?.freeze) {
      const bounds = computeClusterBounds(nodes, stance, resolveStance);
      if (!bounds) continue;

      const targetRadius = computeClusterHaloRadius(bounds);
      smoothed = smoothClusterHaloState(nextSmooth, stance, {
        cx: bounds.cx,
        cy: bounds.cy,
        radius: targetRadius,
      });
      nextSmooth[stance] = smoothed;
    } else if (!smoothed) {
      continue;
    }

    const bucketRadius = bucketClusterHaloRadius(smoothed.radius);
    const cacheKey = `${stance}|${bucketRadius}`;
    let sprite = spriteCache.get(cacheKey);
    if (!sprite) {
      sprite = createClusterHaloSprite(stance, bucketRadius);
      if (spriteCache.size > 48) spriteCache.clear();
      spriteCache.set(cacheKey, sprite);
    }

    const breath = opts?.freeze ? 0.96 : clusterHaloBreathAlpha(stance, nowMs);
    const drawSize = smoothed.radius * 2;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = breath;
    ctx.filter = "none";
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.drawImage(sprite, smoothed.cx - smoothed.radius, smoothed.cy - smoothed.radius, drawSize, drawSize);
    ctx.restore();
  }

  return opts?.freeze ? smoothState : nextSmooth;
}
