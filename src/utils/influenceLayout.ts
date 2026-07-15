import { INFLUENCE_LAYOUT_ADMIN_HANDLE } from "../config/influenceLayout.js";

export const INFLUENCE_LAYOUT_CENTER_BIAS_STRENGTH = 0.009;
export const INFLUENCE_LAYOUT_STANCE_ANCHOR_MUL = 0.55;
export const INFLUENCE_LAYOUT_COLLISION_INFLUENCE_MUL = 0.12;
export const INFLUENCE_LAYOUT_COLLISION_MAX_MUL = 1.12;
export const BREATHING_HALO_PER_STANCE_COUNT = 6;
export const BREATHING_HALO_DURATION_MS = 8000;
export const BREATHING_HALO_OPACITY_MIN = 0.94;
export const BREATHING_HALO_OPACITY_MAX = 1;

type AuthenticatedUser = { handle?: unknown } | null | undefined;

export function normalizeHandle(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^@+/, "");
}

export function isInfluenceLayoutAdminPreview(authenticatedUser: AuthenticatedUser): boolean {
  if (!authenticatedUser?.handle) return false;
  return normalizeHandle(authenticatedUser.handle) === INFLUENCE_LAYOUT_ADMIN_HANDLE;
}

export type InfluenceLayoutDebugOverrides = {
  layoutOverride: boolean | null;
  haloOverride: boolean | null;
};

export function parseDebugInfluenceLayoutParams(
  search: string,
  authenticatedHandle: unknown
): InfluenceLayoutDebugOverrides {
  if (!isInfluenceLayoutAdminPreview({ handle: authenticatedHandle })) {
    return { layoutOverride: null, haloOverride: null };
  }
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const layoutRaw = params.get("debugInfluenceLayout");
  const haloRaw = params.get("debugInfluenceHalo");
  return {
    layoutOverride: layoutRaw === "off" ? false : layoutRaw === "on" ? true : null,
    haloOverride: haloRaw === "off" ? false : null,
  };
}

export function resolveUseInfluenceLayout(opts: {
  enabledForAll: boolean;
  authenticatedUser: AuthenticatedUser;
  layoutOverride: boolean | null;
}): boolean {
  const { enabledForAll, authenticatedUser, layoutOverride } = opts;
  if (enabledForAll) {
    if (layoutOverride === false) return false;
    return true;
  }
  if (!isInfluenceLayoutAdminPreview(authenticatedUser)) return false;
  if (layoutOverride === false) return false;
  if (layoutOverride === true) return true;
  return true;
}

export function resolveUseBreathingHalo(opts: {
  useInfluenceLayout: boolean;
  haloOverride: boolean | null;
  prefersReducedMotion?: boolean;
}): boolean {
  if (!opts.useInfluenceLayout) return false;
  if (opts.haloOverride === false) return false;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeFollowerInfluenceBounds(nodes: Array<{ followers?: number }>): {
  minLog: number;
  maxLog: number;
} {
  let minLog = Infinity;
  let maxLog = -Infinity;
  for (const n of nodes) {
    const logF = Math.log10(Math.max(0, Number(n.followers ?? 0)) + 1);
    if (logF < minLog) minLog = logF;
    if (logF > maxLog) maxLog = logF;
  }
  if (!Number.isFinite(minLog) || !Number.isFinite(maxLog)) {
    return { minLog: 3, maxLog: 6 };
  }
  if (maxLog <= minLog) return { minLog, maxLog: minLog + 1 };
  return { minLog, maxLog };
}

/** Normalized log10 follower influence in [0, 1] for the current graph. */
export function followerInfluence(
  followers: number,
  minLog: number,
  maxLog: number
): number {
  const logF = Math.log10(Math.max(0, followers) + 1);
  if (maxLog <= minLog) return 0.5;
  return clamp((logF - minLog) / (maxLog - minLog), 0, 1);
}

export function centerBiasMultiplier(influence: number): number {
  return 0.42 + 0.58 * influence;
}

export function collisionRadiusMultiplier(influence: number): number {
  const mul = 1 + influence * INFLUENCE_LAYOUT_COLLISION_INFLUENCE_MUL;
  return Math.min(mul, INFLUENCE_LAYOUT_COLLISION_MAX_MUL);
}

export function deterministicUnit(handle: unknown, salt: string): number {
  let hash = 0;
  const s = `${normalizeHandle(handle)}|${salt}`;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return ((hash >>> 0) % 10000) / 10000;
}

export function seedInfluenceLayoutPosition(
  node: { handle: unknown; x: number; y: number; vx: number; vy: number },
  stanceCenterX: number,
  viewportH: number
): void {
  const xJitter = (deterministicUnit(node.handle, "layout-x") - 0.5) * 60;
  const yJitter =
    (deterministicUnit(node.handle, "layout-y") - 0.5) * Math.min(viewportH * 0.5, 400);
  node.x = stanceCenterX + xJitter;
  node.y = viewportH / 2 + yJitter;
  node.vx = 0;
  node.vy = 0;
}

type StanceKey = "against" | "neutral" | "approve";

export function selectTopBreathingHaloHandles(
  nodes: Array<{ handle: unknown; followers?: number }>,
  getStance: (node: { handle: unknown; followers?: number }) => StanceKey | string,
  perStanceCount = BREATHING_HALO_PER_STANCE_COUNT
): Set<string> {
  const byStance: Record<StanceKey, typeof nodes> = {
    against: [],
    neutral: [],
    approve: [],
  };
  for (const n of nodes) {
    const stance = getStance(n) as StanceKey;
    if (stance in byStance) byStance[stance].push(n);
  }
  const out = new Set<string>();
  for (const stance of ["against", "neutral", "approve"] as const) {
    const sorted = [...byStance[stance]].sort((a, b) => {
      const df = (Number(b.followers ?? 0) - Number(a.followers ?? 0));
      if (df !== 0) return df;
      return normalizeHandle(a.handle).localeCompare(normalizeHandle(b.handle));
    });
    const take = Math.min(perStanceCount, sorted.length);
    for (let i = 0; i < take; i++) {
      out.add(normalizeHandle(sorted[i]!.handle));
    }
  }
  return out;
}

export function breathingHaloPhaseOffsetMs(handle: unknown): number {
  return Math.floor(deterministicUnit(handle, "breath-phase") * BREATHING_HALO_DURATION_MS);
}

export function breathingHaloAlpha(
  nowMs: number,
  phaseOffsetMs: number,
  prefersReducedMotion = false
): number {
  if (prefersReducedMotion) {
    return (BREATHING_HALO_OPACITY_MIN + BREATHING_HALO_OPACITY_MAX) / 2;
  }
  const duration = BREATHING_HALO_DURATION_MS;
  const t = ((nowMs + phaseOffsetMs) % duration) / duration;
  const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * t);
  const span = BREATHING_HALO_OPACITY_MAX - BREATHING_HALO_OPACITY_MIN;
  return BREATHING_HALO_OPACITY_MIN + span * wave;
}

type RegionLike = {
  stanceCenterX: Record<string, number>;
  width?: number;
};

type ForceNode = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  followers?: number;
  handle?: unknown;
};

export function createForceInfluenceCenterBias(
  getRegion: () => RegionLike | null,
  getLabels: () => Record<string, string>,
  getStance: (node: ForceNode, labels: Record<string, string>) => string,
  getInfluence: (node: ForceNode) => number,
  viewportH: number,
  strength = INFLUENCE_LAYOUT_CENTER_BIAS_STRENGTH
) {
  let nodes: ForceNode[] = [];
  function force(alpha?: number) {
    const r = getRegion();
    if (!r || !nodes.length) return;
    const cy = viewportH / 2;
    const kBase = Math.max(0, strength) * (alpha ?? 1);
    for (const node of nodes) {
      const stance = getStance(node, getLabels());
      const cx = r.stanceCenterX[stance] ?? (r.width ?? 0) / 2;
      const influence = getInfluence(node);
      const k = kBase * centerBiasMultiplier(influence);
      node.vx += (cx - node.x) * k;
      node.vy += (cy - node.y) * k * 0.72;
    }
  }
  force.initialize = (n: ForceNode[]) => {
    nodes = n;
  };
  return force;
}

export function appendInfluenceLayoutSignatureSuffix(useInfluenceLayout: boolean): string {
  return `|${useInfluenceLayout ? 1 : 0}`;
}
