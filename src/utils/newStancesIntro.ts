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

export const INTRO_HEADING_TOP_PX = 12;
export const INTRO_HEADING_HEIGHT_PX = 22;
export const INTRO_HEADING_GAP_PX = 14;
export const INTRO_LABEL_GAP_PX = 8;

/** Pick one equal staging avatar size; slots may be wider for @handle labels. */
export function computeStagingSidePx(count: number, view: StagingView, maxLabelLen = 10): number {
  if (count <= 0) return 64;
  const padX = 24;
  const minSlotGap = 22;
  const labelCharPx = 7.2;
  const availW = Math.max(100, view.cw - padX * 2);
  const slotW = Math.max(64, maxLabelLen * labelCharPx + 12);
  const totalW = count * slotW + Math.max(0, count - 1) * minSlotGap;
  const fitScale = totalW > availW ? availW / totalW : 1;
  const maxBySlot = (slotW - 12) * fitScale;
  const maxByWidth =
    ((availW - minSlotGap * Math.max(0, count - 1)) / Math.max(1, count) - 12) * fitScale;
  return Math.max(44, Math.min(68, Math.min(maxBySlot, maxByWidth)));
}

export function computeStagingSlotWidth(
  count: number,
  view: StagingView,
  maxLabelLen: number,
  stagingSidePx: number
): { slotW: number; gap: number } {
  const padX = 24;
  const minSlotGap = 22;
  const labelCharPx = 7.2;
  const availW = Math.max(100, view.cw - padX * 2);
  let slotW = Math.max(stagingSidePx + 16, maxLabelLen * labelCharPx + 12);
  let gap = minSlotGap;
  const totalW = count * slotW + Math.max(0, count - 1) * gap;
  if (totalW > availW && count > 0) {
    slotW = (availW - gap * (count - 1)) / count;
    gap = Math.max(10, gap * (availW / totalW));
  }
  return { slotW, gap };
}

/** Compute centered top-middle staging positions under the heading (equal size for all). */
export function computeStagingLayouts(
  items: Array<{ xUserId: string; handle?: string }>,
  view: StagingView
): Map<string, StagingLayout> {
  const out = new Map<string, StagingLayout>();
  const count = items.length;
  if (count === 0) return out;

  const maxLabelLen = Math.max(
    8,
    ...items.map((it) => {
      const h = normalizeHandle(it.handle);
      return h ? `@${h}`.length : 8;
    })
  );
  const stagingSidePx = computeStagingSidePx(count, view, maxLabelLen);
  const { slotW, gap } = computeStagingSlotWidth(count, view, maxLabelLen, stagingSidePx);
  const totalW = count * slotW + Math.max(0, count - 1) * gap;
  const rowStartX = (view.cw - totalW) / 2;
  const avatarTopY = INTRO_HEADING_TOP_PX + INTRO_HEADING_HEIGHT_PX + INTRO_HEADING_GAP_PX;
  const avatarCenterY = avatarTopY + stagingSidePx / 2;

  items.forEach((item, i) => {
    const sx = rowStartX + i * (slotW + gap) + slotW / 2;
    out.set(item.xUserId, { sx, sy: avatarCenterY, stagingSidePx });
  });
  return out;
}

export const INTRO_TIMING = {
  fadeInMs: 400,
  holdMs: 6000,
  headingFadeOutMs: 400,
  headingFadeOutStartMs: 5600,
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

export function headingOpacityForPhase(phase: IntroPhase, elapsedMs: number, reducedMotion: boolean): number {
  if (phase === "idle" || phase === "done") return 0;
  if (phase === "fade-in") return easeInOutCubic(elapsedMs / INTRO_TIMING.fadeInMs);
  if (reducedMotion) {
    if (phase === "hold") return 1;
    if (phase === "flying") return 1 - easeInOutCubic(elapsedMs / INTRO_TIMING.reducedCrossfadeMs);
    return 0;
  }
  if (phase === "hold") {
    if (elapsedMs >= INTRO_TIMING.headingFadeOutStartMs) {
      const t = (elapsedMs - INTRO_TIMING.headingFadeOutStartMs) / INTRO_TIMING.headingFadeOutMs;
      return 1 - easeInOutCubic(t);
    }
    return 1;
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
