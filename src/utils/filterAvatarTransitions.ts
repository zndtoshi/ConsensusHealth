/**
 * Pure helpers for filter-driven avatar enter/exit transitions.
 * Temporary visual transitions only — do not reuse New Stances markers.
 */

import { coerceXUserIdKey, coerceXUserIdToDigitString } from "./xUserId.js";

export type FilterAccountLike = {
  x_user_id?: unknown;
  xUserId?: unknown;
  handle?: unknown;
  username?: unknown;
  screen_name?: unknown;
};

export type FilterStance = "against" | "neutral" | "approve" | string;

export type FilterTransitionTierId = "full" | "medium" | "large" | "reduced";

export type FilterTransitionTier = {
  id: FilterTransitionTierId;
  exitMs: number;
  enterMs: number;
  staggerMs: number;
  maxStaggerMs: number;
  driftPx: number;
  exitEndScale: number;
  enterStartScale: number;
  /** Soft cap on wall-clock transition length (exit || enter+stagger). */
  maxTotalMs: number;
};

export type AccountSetDiff = {
  entering: string[];
  exiting: string[];
  retained: string[];
  previousCount: number;
  nextCount: number;
  changedCount: number;
};

export type Point = { x: number; y: number };

export type StanceClusterBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cx: number;
  cy: number;
  count: number;
};

const HANDLE_RE = /^@+/;

export function normalizeFilterHandle(handle: unknown): string {
  return String(handle ?? "")
    .trim()
    .toLowerCase()
    .replace(HANDLE_RE, "");
}

/** Stable canonical key: exact X user ID string, else normalized handle. */
export function accountStableKey(account: FilterAccountLike | null | undefined): string {
  if (!account) return "";
  const rawId = account.x_user_id ?? account.xUserId;
  const digit = coerceXUserIdToDigitString(rawId);
  if (digit) return `xid:${digit}`;
  const key = coerceXUserIdKey(rawId);
  if (key && /^\d+$/.test(key)) return `xid:${key}`;
  const handle = normalizeFilterHandle(account.handle ?? account.username ?? account.screen_name);
  return handle ? `h:${handle}` : "";
}

export function nodeStableKey(node: FilterAccountLike | null | undefined): string {
  return accountStableKey(node);
}

/** Deterministic unit in [0, 1). Stable across renders for the same key. */
export function hashUnit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

export function prefersFilterReducedMotion(
  matchMediaFn: ((query: string) => { matches: boolean }) | null | undefined = typeof window !== "undefined"
    ? window.matchMedia?.bind(window)
    : undefined
): boolean {
  if (!matchMediaFn) return false;
  try {
    return Boolean(matchMediaFn("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

export function parseDebugFilterTransitions(search: string): { enabled: boolean } {
  const params = new URLSearchParams(search);
  const v = params.get("debugFilterTransitions");
  return { enabled: v === "1" || v === "true" };
}

export function diffAccountKeySets(previousKeys: Iterable<string>, nextKeys: Iterable<string>): AccountSetDiff {
  const prev = new Set<string>();
  for (const k of previousKeys) {
    if (k) prev.add(k);
  }
  const next = new Set<string>();
  for (const k of nextKeys) {
    if (k) next.add(k);
  }
  const entering: string[] = [];
  const exiting: string[] = [];
  const retained: string[] = [];
  for (const k of next) {
    if (prev.has(k)) retained.push(k);
    else entering.push(k);
  }
  for (const k of prev) {
    if (!next.has(k)) exiting.push(k);
  }
  entering.sort();
  exiting.sort();
  retained.sort();
  return {
    entering,
    exiting,
    retained,
    previousCount: prev.size,
    nextCount: next.size,
    changedCount: entering.length + exiting.length,
  };
}

export function diffVisibleAccounts<T extends FilterAccountLike>(
  previous: T[],
  next: T[]
): AccountSetDiff & { previousKeys: string[]; nextKeys: string[] } {
  const previousKeys = previous.map(accountStableKey).filter(Boolean);
  const nextKeys = next.map(accountStableKey).filter(Boolean);
  return { ...diffAccountKeySets(previousKeys, nextKeys), previousKeys, nextKeys };
}

/** Adaptive thresholds: 1–40 full, 41–120 medium, >120 large. */
export const FILTER_TRANSITION_THRESHOLDS = {
  fullMax: 40,
  mediumMax: 120,
} as const;

export function selectFilterTransitionTier(
  changedCount: number,
  reducedMotion: boolean
): FilterTransitionTier {
  if (reducedMotion) {
    return {
      id: "reduced",
      exitMs: 150,
      enterMs: 150,
      staggerMs: 0,
      maxStaggerMs: 0,
      driftPx: 0,
      exitEndScale: 1,
      enterStartScale: 1,
      maxTotalMs: 180,
    };
  }
  if (changedCount <= FILTER_TRANSITION_THRESHOLDS.fullMax) {
    return {
      id: "full",
      exitMs: 360,
      enterMs: 560,
      staggerMs: 14,
      maxStaggerMs: 360,
      driftPx: 34,
      exitEndScale: 0.8,
      enterStartScale: 0.8,
      maxTotalMs: 980,
    };
  }
  if (changedCount <= FILTER_TRANSITION_THRESHOLDS.mediumMax) {
    return {
      id: "medium",
      exitMs: 280,
      enterMs: 420,
      staggerMs: 7,
      maxStaggerMs: 240,
      driftPx: 26,
      exitEndScale: 0.82,
      enterStartScale: 0.82,
      maxTotalMs: 900,
    };
  }
  return {
    id: "large",
    exitMs: 220,
    enterMs: 300,
    staggerMs: 0,
    maxStaggerMs: 0,
    driftPx: 16,
    exitEndScale: 0.85,
    enterStartScale: 0.85,
    maxTotalMs: 800,
  };
}

export function staggerDelayMs(index: number, tier: FilterTransitionTier): number {
  if (tier.staggerMs <= 0 || tier.maxStaggerMs <= 0) return 0;
  return Math.min(tier.maxStaggerMs, Math.max(0, index) * tier.staggerMs);
}

export function transitionTotalDurationMs(
  enteringCount: number,
  exitingCount: number,
  tier: FilterTransitionTier
): number {
  const enterLast = enteringCount > 0 ? staggerDelayMs(enteringCount - 1, tier) + tier.enterMs : 0;
  const exitLast = exitingCount > 0 ? staggerDelayMs(exitingCount - 1, tier) + tier.exitMs : 0;
  return Math.min(tier.maxTotalMs, Math.max(enterLast, exitLast, tier.exitMs, tier.enterMs));
}

/** Modest outward drift by stance; deterministic vertical variation (no Math.random). */
export function exitDriftDelta(
  stance: FilterStance,
  key: string,
  driftPx: number
): Point {
  if (driftPx <= 0) return { x: 0, y: 0 };
  const v = (hashUnit(`${key}:exit`) - 0.5) * 2; // -1..1
  const vert = v * driftPx * 0.4;
  const s = String(stance || "neutral").toLowerCase();
  if (s === "against") return { x: -driftPx, y: vert };
  if (s === "approve") return { x: driftPx, y: vert };
  // Neutral: slight upward / outer edge bias
  const hx = (hashUnit(`${key}:exitx`) - 0.5) * driftPx * 0.35;
  return { x: hx, y: -driftPx * (0.85 + Math.abs(v) * 0.15) };
}

export function computeStanceClusterBounds<T extends { x: number; y: number; half?: number; side?: number }>(
  nodes: T[],
  getStance: (n: T) => FilterStance
): Record<string, StanceClusterBounds> {
  const out: Record<string, StanceClusterBounds> = {};
  for (const n of nodes) {
    const stance = String(getStance(n) || "neutral").toLowerCase();
    const half = n.half ?? (n.side != null ? n.side / 2 : 12);
    const minX = n.x - half;
    const maxX = n.x + half;
    const minY = n.y - half;
    const maxY = n.y + half;
    const cur = out[stance];
    if (!cur) {
      out[stance] = { minX, maxX, minY, maxY, cx: n.x, cy: n.y, count: 1 };
      continue;
    }
    cur.minX = Math.min(cur.minX, minX);
    cur.maxX = Math.max(cur.maxX, maxX);
    cur.minY = Math.min(cur.minY, minY);
    cur.maxY = Math.max(cur.maxY, maxY);
    cur.cx = (cur.cx * cur.count + n.x) / (cur.count + 1);
    cur.cy = (cur.cy * cur.count + n.y) / (cur.count + 1);
    cur.count += 1;
  }
  return out;
}

/**
 * Staging near cluster outer bound (Against left, Approve right, Neutral above).
 * Deterministic jitter from account key + target so avatars do not share one point.
 */
export function enterStagingPosition(opts: {
  stance: FilterStance;
  key: string;
  targetX: number;
  targetY: number;
  bounds?: StanceClusterBounds | null;
  gapPx?: number;
}): Point {
  const gap = opts.gapPx ?? 56;
  const jx = (hashUnit(`${opts.key}:stageX`) - 0.5) * 48;
  const jy = (hashUnit(`${opts.key}:stageY`) - 0.5) * 56;
  const s = String(opts.stance || "neutral").toLowerCase();
  const b = opts.bounds;
  if (s === "against") {
    const edge = b ? b.minX : opts.targetX;
    return { x: edge - gap + jx * 0.35, y: opts.targetY + jy };
  }
  if (s === "approve") {
    const edge = b ? b.maxX : opts.targetX;
    return { x: edge + gap + jx * 0.35, y: opts.targetY + jy };
  }
  const top = b ? b.minY : opts.targetY;
  return { x: opts.targetX + jx, y: top - gap + jy * 0.35 };
}

export type SampledMotion = {
  t: number;
  opacity: number;
  scale: number;
  x: number;
  y: number;
  done: boolean;
  active: boolean;
};

export function sampleExitMotion(opts: {
  elapsedMs: number;
  delayMs: number;
  durationMs: number;
  startX: number;
  startY: number;
  driftX: number;
  driftY: number;
  endScale: number;
  reducedMotion: boolean;
}): SampledMotion {
  const local = opts.elapsedMs - opts.delayMs;
  if (local < 0) {
    return {
      t: 0,
      opacity: 1,
      scale: 1,
      x: opts.startX,
      y: opts.startY,
      done: false,
      active: false,
    };
  }
  const t = opts.durationMs <= 0 ? 1 : Math.min(1, local / opts.durationMs);
  const e = easeOutCubic(t);
  if (opts.reducedMotion) {
    return {
      t,
      opacity: 1 - e,
      scale: 1,
      x: opts.startX,
      y: opts.startY,
      done: t >= 1,
      active: true,
    };
  }
  return {
    t,
    opacity: 1 - e,
    scale: 1 + (opts.endScale - 1) * e,
    x: opts.startX + opts.driftX * e,
    y: opts.startY + opts.driftY * e,
    done: t >= 1,
    active: true,
  };
}

export function sampleEnterMotion(opts: {
  elapsedMs: number;
  delayMs: number;
  durationMs: number;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  startScale: number;
  reducedMotion: boolean;
}): SampledMotion {
  const local = opts.elapsedMs - opts.delayMs;
  if (local < 0) {
    return {
      t: 0,
      opacity: 0,
      scale: opts.reducedMotion ? 1 : opts.startScale,
      x: opts.startX,
      y: opts.startY,
      done: false,
      active: false,
    };
  }
  const t = opts.durationMs <= 0 ? 1 : Math.min(1, local / opts.durationMs);
  const e = easeOutCubic(t);
  if (opts.reducedMotion) {
    return {
      t,
      opacity: e,
      scale: 1,
      x: opts.targetX,
      y: opts.targetY,
      done: t >= 1,
      active: true,
    };
  }
  return {
    t,
    opacity: e,
    scale: opts.startScale + (1 - opts.startScale) * e,
    x: opts.startX + (opts.targetX - opts.startX) * e,
    y: opts.startY + (opts.targetY - opts.startY) * e,
    done: t >= 1,
    active: true,
  };
}

/** Entering avatars become hoverable near completion. */
export const ENTER_HOVERABLE_PROGRESS = 0.85;

export function isEnterHoverable(progress: number): boolean {
  return progress >= ENTER_HOVERABLE_PROGRESS;
}

export function shouldCloseHoverForExitingKey(
  hoverKey: string | null | undefined,
  exitingKeys: Iterable<string>
): boolean {
  if (!hoverKey) return false;
  for (const k of exitingKeys) {
    if (k === hoverKey) return true;
  }
  return false;
}

export function membershipSignatureFromKeys(keys: Iterable<string>): string {
  return [...keys].filter(Boolean).sort().join("\n");
}

export function filterTransitionAnnouncement(opts: {
  joinDateActive?: boolean;
  plebs?: boolean;
  influencers?: boolean;
  visibleCount: number;
}): string {
  const parts: string[] = [];
  if (opts.joinDateActive) parts.push("X join-date filter applied");
  if (opts.plebs) parts.push("Plebs filter applied");
  if (opts.influencers) parts.push("Influencers filter applied");
  if (!parts.length) parts.push("Filters updated");
  return `${parts.join(". ")}. ${opts.visibleCount} accounts visible.`;
}

export type FilterTransitionDebugSnapshot = {
  previousVisibleCount: number;
  nextVisibleCount: number;
  enteringCount: number;
  exitingCount: number;
  retainedCount: number;
  tier: FilterTransitionTierId;
  transitionDurationMs: number;
  animationFrames: number;
  canceled: boolean;
  interrupted: boolean;
  finalSimulationNodeCount: number;
  exitingRemoved: boolean;
};

export function formatFilterTransitionDebug(snap: FilterTransitionDebugSnapshot): string {
  return [
    `[filterTransitions] prev=${snap.previousVisibleCount} next=${snap.nextVisibleCount}`,
    `enter=${snap.enteringCount} exit=${snap.exitingCount} retained=${snap.retainedCount}`,
    `tier=${snap.tier} durationMs=${snap.transitionDurationMs} frames=${snap.animationFrames}`,
    `canceled=${snap.canceled ? 1 : 0} interrupted=${snap.interrupted ? 1 : 0}`,
    `simNodes=${snap.finalSimulationNodeCount} exitingRemoved=${snap.exitingRemoved ? 1 : 0}`,
  ].join(" ");
}

/** Keyboard commit debounce after accessible range adjustments (ms). */
export const JOIN_DATE_KEYBOARD_COMMIT_MS = 180;
