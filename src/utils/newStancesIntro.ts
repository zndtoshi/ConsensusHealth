import type { NewStanceEvent } from "../api/newStances.js";
import { NEW_STANCES_PUBLIC_ENABLED } from "../config/newStances.js";

export const LAST_SEEN_MARKER_KEY = "consensus_health_last_seen_stance_event_v2";
export const PLAYING_SESSION_KEY = "consensus_health_new_stances_playing_v2";
export const INTRO_MAX_USERS = 9;

export type LastSeenMarker = {
  eventId: number;
  createdAt: string;
};

export type PlayingSession = {
  batchId: string;
  eventIds: number[];
  startedAt: string;
};

export type StanceKey = "against" | "neutral" | "approve";

export type IntroItem = {
  eventId: number;
  xUserId: string;
  handle: string;
  stance: StanceKey;
  createdAt: string;
  avatarUrl: string;
  /** Reserved final graph coordinates (world space). */
  finalX: number;
  finalY: number;
  finalSide: number;
  /** Staging screen coordinates (CSS px) — center of avatar. */
  stagingSx: number;
  stagingSy: number;
  /** Uniform large avatar size while staged (screen px). */
  stagingSidePx: number;
  /** Flight timing (performance.now ms). */
  flightStart: number;
  flightEnd: number;
  landed: boolean;
  opacity: number;
};

export type DebugNewStancesParams = {
  enabled: boolean;
  limit: number;
};

export type ShowIntroDecision = {
  show: boolean;
  adminPreview: boolean;
  publicEnabled: boolean;
  debug: DebugNewStancesParams;
};

const PLAYING_STALE_MS = 60_000;

export function normalizeHandle(handle: unknown): string {
  return String(handle ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function parseDebugNewStancesParams(search: string): DebugNewStancesParams {
  const params = new URLSearchParams(search);
  const enabled = params.get("debugNewStances") === "1";
  const countRaw = Number(params.get("debugNewStancesCount"));
  const limit =
    enabled && Number.isFinite(countRaw) && countRaw > 0
      ? Math.max(1, Math.min(INTRO_MAX_USERS, Math.trunc(countRaw)))
      : INTRO_MAX_USERS;
  return { enabled, limit };
}

export function resolveShowIntroDecision(opts: {
  adminPreviewFromServer: boolean;
  publicEnabled?: boolean;
  debug?: DebugNewStancesParams;
}): ShowIntroDecision {
  const publicEnabled = opts.publicEnabled ?? NEW_STANCES_PUBLIC_ENABLED;
  const debug = opts.debug ?? { enabled: false, limit: INTRO_MAX_USERS };
  const adminPreview = Boolean(opts.adminPreviewFromServer);
  const show = adminPreview || publicEnabled || debug.enabled;
  return { show, adminPreview, publicEnabled, debug };
}

export function readLastSeenMarker(storage: Pick<Storage, "getItem">): LastSeenMarker | null {
  try {
    const raw = storage.getItem(LAST_SEEN_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastSeenMarker>;
    const eventId = Number(parsed.eventId);
    const createdAt = String(parsed.createdAt ?? "").trim();
    if (!Number.isFinite(eventId) || eventId <= 0 || !createdAt) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { eventId: Math.trunc(eventId), createdAt };
  } catch {
    return null;
  }
}

export function writeLastSeenMarker(storage: Pick<Storage, "setItem">, marker: LastSeenMarker): void {
  try {
    storage.setItem(LAST_SEEN_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // ignore quota / privacy mode
  }
}

export function readPlayingSession(storage: Pick<Storage, "getItem">): PlayingSession | null {
  try {
    const raw = storage.getItem(PLAYING_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlayingSession>;
    const batchId = String(parsed.batchId ?? "").trim();
    const startedAt = String(parsed.startedAt ?? "").trim();
    const eventIds = Array.isArray(parsed.eventIds)
      ? parsed.eventIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (!batchId || !startedAt || eventIds.length === 0) return null;
    const age = Date.now() - Date.parse(startedAt);
    if (Number.isNaN(age) || age > PLAYING_STALE_MS) return null;
    return { batchId, eventIds, startedAt };
  } catch {
    return null;
  }
}

export function writePlayingSession(storage: Pick<Storage, "setItem">, session: PlayingSession): void {
  try {
    storage.setItem(PLAYING_SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore
  }
}

export function clearPlayingSession(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(PLAYING_SESSION_KEY);
  } catch {
    // ignore
  }
}

/** Client-side guard: dedupe by xUserId, cap limit, sort newest first. */
export function normalizeIntroEvents(events: NewStanceEvent[], limit = INTRO_MAX_USERS): NewStanceEvent[] {
  const latestByUser = new Map<string, NewStanceEvent>();
  for (const e of events) {
    const xUserId = String(e.xUserId ?? "").trim();
    if (!xUserId) continue;
    const existing = latestByUser.get(xUserId);
    if (!existing || e.eventId > existing.eventId) latestByUser.set(xUserId, e);
  }
  return [...latestByUser.values()]
    .sort((a, b) => b.eventId - a.eventId || Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, Math.min(INTRO_MAX_USERS, limit)));
}

export function pickNewestMarker(events: NewStanceEvent[]): LastSeenMarker | null {
  if (!events.length) return null;
  const newest = events.reduce((a, b) => (a.eventId >= b.eventId ? a : b));
  return { eventId: newest.eventId, createdAt: newest.createdAt };
}

export function resolveFetchAfterEventId(opts: {
  adminPreview: boolean;
  publicEnabled: boolean;
  debug: DebugNewStancesParams;
  marker: LastSeenMarker | null;
}): number | null {
  if (opts.adminPreview || opts.debug.enabled) return null;
  if (!opts.publicEnabled) return null;
  return opts.marker?.eventId ?? null;
}

export function shouldPersistMarker(opts: {
  adminPreview: boolean;
  publicEnabled: boolean;
  debug: DebugNewStancesParams;
}): boolean {
  if (opts.adminPreview || opts.debug.enabled) return false;
  return opts.publicEnabled;
}

export function easeInOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function quadBezierPoint(
  t: number,
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

export type StagingView = {
  cw: number;
  ch: number;
  headerHeight: number;
  scale: number;
  tx: number;
  ty: number;
  stanceCenterX: Record<StanceKey, number>;
};

export type StagingLayout = {
  sx: number;
  sy: number;
  stagingSidePx: number;
};

export const INTRO_HEADING_TOP_PX = 10;
export const INTRO_HEADING_HEIGHT_PX = 20;
export const INTRO_HEADING_GAP_PX = 8;
export const INTRO_LABEL_GAP_PX = 4;
/** Horizontal gap between staged avatars. */
export const STAGING_AVATAR_GAP_PX = 8;
/** Keep the staging band compact so it stays above the graph clusters. */
export const STAGING_MAX_SIDE_PX = 54;
export const STAGING_MIN_SIDE_PX = 38;
export const STAGING_ROW_PAD_X = 40;

/** Shorten long handles so labels fit in tight slots without widening the row. */
export function formatIntroHandleLabel(handle: unknown, maxLen = 11): string {
  const h = normalizeHandle(handle);
  if (!h) return "@user";
  const label = `@${h}`;
  if (label.length <= maxLen) return label;
  return `${label.slice(0, Math.max(4, maxLen - 1))}…`;
}

/** Pick one equal staging avatar size that fits a tight centered row without overlapping the graph. */
export function computeStagingSidePx(count: number, view: StagingView): number {
  if (count <= 0) return STAGING_MAX_SIDE_PX;
  const availW = Math.max(120, view.cw - STAGING_ROW_PAD_X * 2);
  const gap = STAGING_AVATAR_GAP_PX;
  const byWidth = (availW - gap * Math.max(0, count - 1)) / Math.max(1, count);
  return Math.max(
    STAGING_MIN_SIDE_PX,
    Math.min(STAGING_MAX_SIDE_PX, Math.floor(byWidth))
  );
}

/** Compute a tight, centered top row directly under the heading. */
export function computeStagingLayouts(
  items: Array<{ xUserId: string; handle?: string }>,
  view: StagingView
): Map<string, StagingLayout> {
  const out = new Map<string, StagingLayout>();
  const count = items.length;
  if (count === 0) return out;

  const stagingSidePx = computeStagingSidePx(count, view);
  const gap = STAGING_AVATAR_GAP_PX;
  const totalW = count * stagingSidePx + Math.max(0, count - 1) * gap;
  const rowStartX = (view.cw - totalW) / 2;
  const avatarTopY = INTRO_HEADING_TOP_PX + INTRO_HEADING_HEIGHT_PX + INTRO_HEADING_GAP_PX;
  const avatarCenterY = avatarTopY + stagingSidePx / 2;

  items.forEach((item, i) => {
    const sx = rowStartX + i * (stagingSidePx + gap) + stagingSidePx / 2;
    out.set(item.xUserId, { sx, sy: avatarCenterY, stagingSidePx });
  });
  return out;
}

export type StagingPanelBounds = {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
};

/** Background tile behind the heading + staged avatars + labels. */
export function computeStagingPanelBounds(
  count: number,
  stagingSidePx: number,
  view: StagingView
): StagingPanelBounds {
  const gap = STAGING_AVATAR_GAP_PX;
  const totalW = count * stagingSidePx + Math.max(0, count - 1) * gap;
  const rowStartX = (view.cw - totalW) / 2;
  const avatarTopY = INTRO_HEADING_TOP_PX + INTRO_HEADING_HEIGHT_PX + INTRO_HEADING_GAP_PX;
  const labelH = 15;
  const padX = 24;
  const padTop = 8;
  const padBottom = 18;
  const x = Math.max(8, rowStartX - padX);
  const y = INTRO_HEADING_TOP_PX - padTop;
  const w = Math.min(view.cw - 16, totalW + padX * 2);
  const h = avatarTopY - y + stagingSidePx + INTRO_LABEL_GAP_PX + labelH + padBottom;
  return { x, y, w, h, r: 16 };
}

export const INTRO_TIMING = {
  fadeInMs: 400,
  /** Full staging hold before any avatar flies (must stay 6s). */
  holdMs: 6000,
  headingFadeOutMs: 500,
  /** Heading fades only once flight begins, not before the 6s hold ends. */
  headingFadeOutStartMs: 6000,
  flightMs: 1100,
  flightStaggerMs: 70,
  reducedHoldMs: 1200,
  reducedCrossfadeMs: 400,
};

let introSessionLock = false;

/** Prevents duplicate intro fetch/start within the same page load (React Strict Mode). */
export function lockIntroSession(): boolean {
  if (introSessionLock) return false;
  introSessionLock = true;
  return true;
}

export function resetIntroSessionLockForTests(): void {
  introSessionLock = false;
}

export type IntroPhase = "idle" | "fade-in" | "hold" | "flying" | "done";

export function getIntroPhase(elapsedMs: number, reducedMotion: boolean): IntroPhase {
  if (reducedMotion) {
    if (elapsedMs < INTRO_TIMING.fadeInMs) return "fade-in";
    if (elapsedMs < INTRO_TIMING.fadeInMs + INTRO_TIMING.reducedHoldMs) return "hold";
    if (elapsedMs < INTRO_TIMING.fadeInMs + INTRO_TIMING.reducedHoldMs + INTRO_TIMING.reducedCrossfadeMs) return "flying";
    return "done";
  }
  if (elapsedMs < INTRO_TIMING.fadeInMs) return "fade-in";
  if (elapsedMs < INTRO_TIMING.holdMs) return "hold";
  if (elapsedMs < INTRO_TIMING.holdMs + INTRO_TIMING.flightMs + INTRO_TIMING.flightStaggerMs * INTRO_MAX_USERS) return "flying";
  return "done";
}

export function headingOpacityForPhase(
  phase: IntroPhase,
  elapsedMs: number,
  reducedMotion: boolean,
  itemCount = INTRO_MAX_USERS
): number {
  if (phase === "idle" || phase === "done") return 0;
  if (phase === "fade-in") return easeInOutCubic(elapsedMs / INTRO_TIMING.fadeInMs);
  if (phase === "hold") return 1;
  if (phase === "flying") {
    const panel = stagingPanelOpacityForPhase(phase, elapsedMs, itemCount, reducedMotion);
    return panel > 0 ? panel / 0.94 : 0;
  }
  return 0;
}

/** Panel stays solid through the 6s hold, then fades out as avatars fly away. */
export function stagingPanelOpacityForPhase(
  phase: IntroPhase,
  elapsedMs: number,
  itemCount: number,
  reducedMotion: boolean
): number {
  const maxAlpha = 0.94;
  if (phase === "idle" || phase === "done") return 0;
  if (phase === "fade-in") return easeInOutCubic(elapsedMs / INTRO_TIMING.fadeInMs) * maxAlpha;
  if (phase === "hold") return maxAlpha;
  if (phase === "flying") {
    const holdEnd = reducedMotion
      ? INTRO_TIMING.fadeInMs + INTRO_TIMING.reducedHoldMs
      : INTRO_TIMING.holdMs;
    const flightElapsed = Math.max(0, elapsedMs - holdEnd);
    const flightSpan = reducedMotion
      ? INTRO_TIMING.reducedCrossfadeMs
      : INTRO_TIMING.flightMs + INTRO_TIMING.flightStaggerMs * Math.max(0, itemCount - 1);
    const t = Math.min(1, flightElapsed / Math.max(1, flightSpan));
    return maxAlpha * (1 - easeInOutCubic(t));
  }
  return 0;
}

export function itemOpacityForPhase(
  item: IntroItem,
  phase: IntroPhase,
  elapsedMs: number,
  itemIndex: number,
  reducedMotion: boolean
): number {
  if (phase === "idle") return 0;
  if (item.landed) return 1;
  if (phase === "fade-in") return easeInOutCubic(elapsedMs / INTRO_TIMING.fadeInMs);
  if (phase === "hold") return 1;
  if (phase === "flying") {
    const now = performance.now();
    if (now < item.flightStart) return 1;
    if (now >= item.flightEnd) return 1;
    return 1;
  }
  return 1;
}

export function computeFlightScreenPos(
  item: IntroItem,
  now: number,
  view: StagingView,
  reducedMotion: boolean
): { sx: number; sy: number; sidePx: number; labelOpacity: number } {
  const finalSx = item.finalX * view.scale + view.tx;
  const finalSy = item.finalY * view.scale + view.ty;
  const finalSidePx = Math.max(8, item.finalSide * view.scale);
  const stagingSidePx = item.stagingSidePx || finalSidePx;

  if (item.landed || now >= item.flightEnd) {
    return { sx: finalSx, sy: finalSy, sidePx: finalSidePx, labelOpacity: 0 };
  }
  if (now < item.flightStart) {
    const bob = reducedMotion ? 0 : Math.sin(now * 0.0025) * 3;
    return { sx: item.stagingSx, sy: item.stagingSy + bob, sidePx: stagingSidePx, labelOpacity: 1 };
  }

  const tRaw = (now - item.flightStart) / Math.max(1, item.flightEnd - item.flightStart);
  const t = easeInOutCubic(tRaw);
  const sidePx = stagingSidePx + (finalSidePx - stagingSidePx) * t;
  const labelOpacity = Math.max(0, 1 - t * 1.2);
  if (reducedMotion) {
    return {
      sx: item.stagingSx + (finalSx - item.stagingSx) * t,
      sy: item.stagingSy + (finalSy - item.stagingSy) * t,
      sidePx,
      labelOpacity,
    };
  }
  const mid = {
    x: (item.stagingSx + finalSx) / 2,
    y: Math.min(item.stagingSy, finalSy) - 40,
  };
  const pt = quadBezierPoint(
    t,
    { x: item.stagingSx, y: item.stagingSy },
    mid,
    { x: finalSx, y: finalSy }
  );
  return { sx: pt.x, sy: pt.y, sidePx, labelOpacity };
}

export function scheduleFlightTimes(
  items: IntroItem[],
  flightStartBase: number,
  reducedMotion: boolean
): IntroItem[] {
  const flightMs = reducedMotion ? INTRO_TIMING.reducedCrossfadeMs : INTRO_TIMING.flightMs;
  const stagger = reducedMotion ? 0 : INTRO_TIMING.flightStaggerMs;
  return items.map((item, i) => ({
    ...item,
    flightStart: flightStartBase + i * stagger,
    flightEnd: flightStartBase + i * stagger + flightMs,
    landed: false,
    opacity: 0,
  }));
}

export function isIntroNodeHidden(
  xUserId: string,
  hiddenIds: ReadonlySet<string>,
  landedIds: ReadonlySet<string>
): boolean {
  if (!hiddenIds.has(xUserId)) return false;
  return !landedIds.has(xUserId);
}

export function matchEventsToIntroItems(
  events: NewStanceEvent[],
  nodes: Array<{
    x_user_id?: string | null;
    handle: string;
    x: number;
    y: number;
    side: number;
    avatarUrl?: string;
  }>,
  resolveEventAvatarUrl: (event: NewStanceEvent, nodeAvatarUrl?: string) => string
): IntroItem[] {
  const nodeByXid = new Map<string, (typeof nodes)[number]>();
  const nodeByHandle = new Map<string, (typeof nodes)[number]>();
  for (const n of nodes) {
    const xid = String(n.x_user_id ?? "").trim();
    if (xid) nodeByXid.set(xid, n);
    const h = normalizeHandle(n.handle);
    if (h) nodeByHandle.set(h, n);
  }

  const items: IntroItem[] = [];
  for (const e of normalizeIntroEvents(events)) {
    const node =
      nodeByXid.get(e.xUserId) ||
      (e.handle ? nodeByHandle.get(normalizeHandle(e.handle)) : undefined);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    items.push({
      eventId: e.eventId,
      xUserId: e.xUserId,
      handle: normalizeHandle(e.handle || node.handle),
      stance: e.stance,
      createdAt: e.createdAt,
      avatarUrl: resolveEventAvatarUrl(e, node.avatarUrl),
      finalX: node.x,
      finalY: node.y,
      finalSide: node.side,
      stagingSx: 0,
      stagingSy: 0,
      stagingSidePx: 64,
      flightStart: 0,
      flightEnd: 0,
      landed: false,
      opacity: 0,
    });
  }
  return items;
}
