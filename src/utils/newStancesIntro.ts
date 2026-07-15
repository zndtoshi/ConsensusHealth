import type { NewStanceEvent } from "../api/newStances.js";
import { NEW_STANCES_HEADING, NEW_STANCES_PUBLIC_ENABLED } from "../config/newStances.js";
import { STANCE_COLORS } from "./stanceColors.js";

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
  publicEnabled?: boolean;
  debug?: DebugNewStancesParams;
}): ShowIntroDecision {
  const publicEnabled = opts.publicEnabled ?? NEW_STANCES_PUBLIC_ENABLED;
  const debug = opts.debug ?? { enabled: false, limit: INTRO_MAX_USERS };
  const show = publicEnabled || debug.enabled;
  return { show, publicEnabled, debug };
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

/**
 * Latest-per-user stance events for the public intro.
 *
 * Returning visitors: when more than 9 unseen events exist, only the newest 9 are
 * shown. The saved marker advances to the newest displayed event, so older unseen
 * events skipped by the cap are not replayed on the next visit.
 */
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
  publicEnabled: boolean;
  debug: DebugNewStancesParams;
  marker: LastSeenMarker | null;
}): number | null {
  if (opts.debug.enabled) return null;
  if (!opts.publicEnabled) return null;
  return opts.marker?.eventId ?? null;
}

export function shouldPersistMarker(opts: {
  publicEnabled: boolean;
  debug: DebugNewStancesParams;
}): boolean {
  if (opts.debug.enabled) return false;
  return opts.publicEnabled;
}

/**
 * Refresh mid-animation: while sessionStorage has a fresh playing session (<60s),
 * defer starting another intro so localStorage is not advanced prematurely.
 * If the tab closes mid-animation, the marker stays unchanged until the intro
 * completes successfully or the playing session goes stale (>60s), after which
 * the same unseen batch may replay once.
 */
export function shouldDeferIntroForPlayingSession(
  playing: PlayingSession | null,
  opts: { publicEnabled: boolean; debug: DebugNewStancesParams }
): boolean {
  return Boolean(playing && opts.publicEnabled && !opts.debug.enabled);
}

/** Marker advances only to events that were actually displayed in the intro. */
export function markerEventsFromIntroItems(items: Array<Pick<IntroItem, "eventId" | "createdAt">>): NewStanceEvent[] {
  return items.map((it) => ({
    eventId: it.eventId,
    xUserId: "",
    handle: "",
    displayName: null,
    stance: "neutral" as const,
    createdAt: it.createdAt,
    avatarPath: null,
    hasAvatarBlob: false,
  }));
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

/** Matches `.newStancesHeading { top: 14px }` in index.css. */
export const INTRO_HEADING_TOP_PX = 14;
/** Single-line heading (~14px font). */
export const INTRO_HEADING_HEIGHT_PX = 20;
/** Space between heading baseline block and avatar row tops. */
export const INTRO_HEADING_GAP_PX = 18;
/** Panel padding and shape (glass card). */
export const INTRO_PANEL_PAD_X = 16;
export const INTRO_PANEL_PAD_TOP = 10;
export const INTRO_PANEL_PAD_BOTTOM = 14;
export const INTRO_PANEL_MAX_WIDTH_PX = 760;
export const INTRO_PANEL_RADIUS_PX = 18;
export const INTRO_COUNTDOWN_HEIGHT_PX = 10;
/** Matches `.newStancesHeading` (14px semibold + 16px side padding). */
export const INTRO_HEADING_FONT_PX = 14;
export const INTRO_HEADING_TEXT_PAD_X_PX = 32;
/** Horizontal gap between staged avatars. */
export const STAGING_AVATAR_GAP_PX = 10;
/** Staged avatar size bounds (~12% larger than prior 54px cap). */
export const STAGING_MAX_SIDE_PX = 60;
export const STAGING_MIN_SIDE_PX = 42;
export const STAGING_ROW_PAD_X = 32;

/** Minimum inner panel width so the heading fits on one line. */
export function introHeadingMinContentWidthPx(heading = NEW_STANCES_HEADING): number {
  let textW = INTRO_HEADING_TEXT_PAD_X_PX;
  for (const ch of heading) {
    const em = ch === " " ? 0.33 : 0.58;
    textW += INTRO_HEADING_FONT_PX * em + INTRO_HEADING_FONT_PX * 0.02;
  }
  return Math.ceil(textW);
}

/** Raise the intro band into the lower half of the app header (canvas coords). */
export function computeIntroBandLiftPx(headerHeight: number): number {
  return Math.round(Math.max(0, headerHeight) / 2);
}

/** Accessible name for a staged avatar (visible handles removed from panel). */
export function introAvatarAriaLabel(handle: unknown, stance: StanceKey): string {
  const h = normalizeHandle(handle);
  const name = h ? `@${h}` : "community member";
  const stanceLabel =
    stance === "against" ? "Against" : stance === "approve" ? "Approve" : "Neutral";
  return `${name}, stance ${stanceLabel}`;
}

/** Responsive staged avatar size: clamp(42px, 3.2vw, 60px) capped by row fit. */
export function computeStagingSidePx(count: number, view: StagingView): number {
  const responsive = Math.round(Math.max(STAGING_MIN_SIDE_PX, Math.min(STAGING_MAX_SIDE_PX, view.cw * 0.032)));
  if (count <= 0) return responsive;
  const availW = Math.max(120, Math.min(INTRO_PANEL_MAX_WIDTH_PX, view.cw - 32) - INTRO_PANEL_PAD_X * 2);
  const gap = STAGING_AVATAR_GAP_PX;
  const byWidth = (availW - gap * Math.max(0, count - 1)) / Math.max(1, count);
  return Math.max(STAGING_MIN_SIDE_PX, Math.min(responsive, Math.floor(byWidth)));
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

/** Background tile behind the heading + staged avatars (+ optional countdown). */
export function computeStagingPanelBounds(
  count: number,
  stagingSidePx: number,
  view: StagingView
): StagingPanelBounds {
  const gap = STAGING_AVATAR_GAP_PX;
  const totalW = count * stagingSidePx + Math.max(0, count - 1) * gap;
  const avatarTopY = INTRO_HEADING_TOP_PX + INTRO_HEADING_HEIGHT_PX + INTRO_HEADING_GAP_PX;
  const contentW = Math.max(totalW, introHeadingMinContentWidthPx());
  const w = Math.min(
    view.cw - 16,
    Math.min(INTRO_PANEL_MAX_WIDTH_PX, contentW + INTRO_PANEL_PAD_X * 2)
  );
  const x = Math.max(8, (view.cw - w) / 2);
  const y = INTRO_HEADING_TOP_PX - INTRO_PANEL_PAD_TOP;
  const h =
    avatarTopY -
    y +
    stagingSidePx +
    INTRO_COUNTDOWN_HEIGHT_PX +
    6 +
    INTRO_PANEL_PAD_BOTTOM;
  return { x, y, w, h, r: INTRO_PANEL_RADIUS_PX };
}

export const INTRO_TIMING = {
  /** Panel + avatar entrance (fade/scale stagger). */
  fadeInMs: 300,
  entranceStaggerMs: 35,
  /** Time from intro start until the first avatar flies (includes fade-in). */
  holdMs: 3000,
  headingFadeOutMs: 500,
  /** Heading fades only once flight begins, not before the hold ends. */
  headingFadeOutStartMs: 3000,
  /** Glass panel fades out quickly once flight begins. */
  panelFlightFadeMs: 220,
  flightMs: 2200,
  flightStaggerMs: 70,
  reducedCrossfadeMs: 400,
};

/** cubic-bezier(0.22, 1, 0.36, 1) — entrance easing */
export function easeIntroEntrance(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - (1 - x) ** 3;
}

export function introAvatarEntrance(
  itemIndex: number,
  elapsedMs: number,
  reducedMotion: boolean
): { opacity: number; scale: number } {
  if (reducedMotion) {
    const t = Math.min(1, elapsedMs / INTRO_TIMING.fadeInMs);
    return { opacity: easeInOutCubic(t), scale: 1 };
  }
  const local = Math.max(0, elapsedMs - itemIndex * INTRO_TIMING.entranceStaggerMs);
  const t = Math.min(1, local / INTRO_TIMING.fadeInMs);
  const eased = easeIntroEntrance(t);
  return { opacity: eased, scale: 0.92 + 0.08 * eased };
}

/** Subtle launch dots visible only during the final ~900ms of the hold. */
export function introCountdownDotOpacity(
  dotIndex: number,
  phase: IntroPhase,
  elapsedMs: number,
  reducedMotion: boolean
): number {
  if (reducedMotion || phase !== "hold") return 0;
  const windowStart = INTRO_TIMING.holdMs - 900;
  if (elapsedMs < windowStart || elapsedMs >= INTRO_TIMING.holdMs) return 0;
  const t = (elapsedMs - windowStart) / 900;
  const dotStart = dotIndex * 0.22;
  const dotPeak = dotStart + 0.16;
  const dotFade = dotStart + 0.42;
  if (t < dotStart) return 0.12;
  if (t < dotPeak) return 0.12 + 0.42 * easeInOutCubic((t - dotStart) / (dotPeak - dotStart));
  if (t < dotFade) return 0.54;
  return Math.max(0, 0.54 * (1 - easeInOutCubic(Math.min(1, (t - dotFade) / 0.18))));
}

/** Stance-colored border and glow for staged avatars (matches graph palette). */
export function introStanceAura(stance: StanceKey): { border: string; glow: string; fill: string } {
  if (stance === "against") {
    return {
      border: STANCE_COLORS.against,
      glow: "rgba(239, 68, 68, 0.42)",
      fill: "rgba(239, 68, 68, 0.14)",
    };
  }
  if (stance === "approve") {
    return {
      border: STANCE_COLORS.approve,
      glow: "rgba(34, 197, 94, 0.42)",
      fill: "rgba(34, 197, 94, 0.14)",
    };
  }
  return {
    border: STANCE_COLORS.neutral,
    glow: "rgba(255, 255, 255, 0.24)",
    fill: "rgba(156, 163, 175, 0.16)",
  };
}

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
  if (elapsedMs < INTRO_TIMING.fadeInMs) return "fade-in";
  if (elapsedMs < INTRO_TIMING.holdMs) return "hold";
  const flightSpan = reducedMotion
    ? INTRO_TIMING.reducedCrossfadeMs
    : INTRO_TIMING.flightMs + INTRO_TIMING.flightStaggerMs * INTRO_MAX_USERS;
  if (elapsedMs < INTRO_TIMING.holdMs + flightSpan) return "flying";
  return "done";
}

export function headingOpacityForPhase(
  phase: IntroPhase,
  elapsedMs: number,
  reducedMotion: boolean,
  itemCount = INTRO_MAX_USERS
): number {
  if (phase === "idle" || phase === "done") return 0;
  if (phase === "fade-in") return easeIntroEntrance(elapsedMs / INTRO_TIMING.fadeInMs);
  if (phase === "hold") return 1;
  if (phase === "flying") {
    const panel = stagingPanelOpacityForPhase(phase, elapsedMs, itemCount, reducedMotion);
    return panel > 0 ? panel / 0.94 : 0;
  }
  return 0;
}

/** Panel stays solid through the staging hold, then fades out as avatars fly away. */
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
    const flightElapsed = Math.max(0, elapsedMs - INTRO_TIMING.holdMs);
    const fadeMs = reducedMotion ? INTRO_TIMING.reducedCrossfadeMs : INTRO_TIMING.panelFlightFadeMs;
    const t = Math.min(1, flightElapsed / Math.max(1, fadeMs));
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
  if (phase === "fade-in") return easeIntroEntrance(elapsedMs / INTRO_TIMING.fadeInMs);
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
    const phaseOffset = (item.eventId % 7) * 0.45;
    const bob = reducedMotion ? 0 : Math.sin(now * 0.0022 + phaseOffset) * 2.5;
    return { sx: item.stagingSx, sy: item.stagingSy + bob, sidePx: stagingSidePx, labelOpacity: 0 };
  }

  const tRaw = (now - item.flightStart) / Math.max(1, item.flightEnd - item.flightStart);
  const t = easeInOutCubic(tRaw);
  const sidePx = stagingSidePx + (finalSidePx - stagingSidePx) * t;
  const labelOpacity = 0;
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
