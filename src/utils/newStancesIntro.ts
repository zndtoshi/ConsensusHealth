/**
 * Pure logic for the "New stances" arrival animation:
 *  - reading/writing the browser's last-seen stance-event marker (localStorage),
 *    with corruption protection and a versioned key;
 *  - selecting which events to animate (latest/final per user, newest first,
 *    capped), independent of any DOM/animation concerns so it is unit-testable.
 */

export const NEW_STANCES_MARKER_KEY = "consensus_health_last_seen_stance_event_v1";

/** Default and hard maximum number of avatars shown per intro. */
export const NEW_STANCES_MAX = 9;

export type IntroStance = "against" | "neutral" | "approve";

export type IntroMarker = {
  eventId: number;
  createdAt: string;
};

export type NewStanceEvent = {
  eventId: number;
  xUserId: string;
  handle: string | null;
  displayName: string | null;
  stance: string;
  createdAt: string;
  avatarUrl?: string | null;
  hasAvatarBlob?: boolean;
};

export type SelectedIntroEvent = NewStanceEvent & {
  handle: string;
  stance: IntroStance;
};

/** Minimal storage surface so tests can inject a fake without a DOM. */
export interface IntroStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VALID_STANCES: ReadonlySet<string> = new Set<IntroStance>(["against", "neutral", "approve"]);

function isValidStance(value: unknown): value is IntroStance {
  return typeof value === "string" && VALID_STANCES.has(value);
}

function toPositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const truncated = Math.trunc(n);
  return truncated > 0 ? truncated : null;
}

/**
 * Read the last-seen marker. Returns null for a first visit, missing/blank
 * value, or any corrupt/invalid JSON (never throws).
 */
export function readLastSeenMarker(storage: IntroStorage | null | undefined): IntroMarker | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(NEW_STANCES_MARKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const eventId = toPositiveInt((parsed as Record<string, unknown>).eventId);
  if (eventId == null) return null;
  const createdAtRaw = (parsed as Record<string, unknown>).createdAt;
  const createdAt = typeof createdAtRaw === "string" ? createdAtRaw : "";
  return { eventId, createdAt };
}

/** Persist the marker. Never throws (storage may be unavailable/full). */
export function writeLastSeenMarker(
  storage: IntroStorage | null | undefined,
  marker: IntroMarker
): boolean {
  if (!storage) return false;
  const eventId = toPositiveInt(marker?.eventId);
  if (eventId == null) return false;
  try {
    storage.setItem(
      NEW_STANCES_MARKER_KEY,
      JSON.stringify({ eventId, createdAt: String(marker?.createdAt ?? "") })
    );
    return true;
  } catch {
    return false;
  }
}

/** Keep only events strictly newer than the marker (by monotonic eventId). */
export function filterNewerThanMarker(
  events: readonly NewStanceEvent[],
  marker: IntroMarker | null | undefined
): NewStanceEvent[] {
  if (!marker) return [...events];
  const after = toPositiveInt(marker.eventId) ?? 0;
  return events.filter((e) => (toPositiveInt(e.eventId) ?? 0) > after);
}

/**
 * Select the events to animate:
 *  - drop events without a usable handle/xUserId/stance/eventId;
 *  - deduplicate by xUserId, keeping the latest (highest eventId) per user;
 *  - sort newest-first (by eventId);
 *  - cap to `max` (default {@link NEW_STANCES_MAX}, hard-limited to it).
 */
export function selectIntroEvents(
  events: readonly NewStanceEvent[],
  opts?: { max?: number }
): SelectedIntroEvent[] {
  const max = Math.max(1, Math.min(NEW_STANCES_MAX, Math.trunc(opts?.max ?? NEW_STANCES_MAX) || NEW_STANCES_MAX));
  const latestByUser = new Map<string, SelectedIntroEvent>();
  for (const e of events) {
    const eventId = toPositiveInt(e?.eventId);
    const xUserId = String(e?.xUserId ?? "").trim();
    const handle = String(e?.handle ?? "").trim();
    if (eventId == null || !xUserId || !handle || !isValidStance(e?.stance)) continue;
    const candidate: SelectedIntroEvent = { ...e, eventId, xUserId, handle, stance: e.stance };
    const existing = latestByUser.get(xUserId);
    if (!existing || candidate.eventId > existing.eventId) latestByUser.set(xUserId, candidate);
  }
  return [...latestByUser.values()].sort((a, b) => b.eventId - a.eventId).slice(0, max);
}

/** Newest marker across the given events (highest eventId), or null if none. */
export function computeNewestMarker(events: readonly NewStanceEvent[]): IntroMarker | null {
  let best: IntroMarker | null = null;
  for (const e of events) {
    const eventId = toPositiveInt(e?.eventId);
    if (eventId == null) continue;
    if (!best || eventId > best.eventId) best = { eventId, createdAt: String(e?.createdAt ?? "") };
  }
  return best;
}

/** Whether the environment requests reduced motion (safe in non-DOM contexts). */
export function prefersReducedMotion(win?: { matchMedia?: (q: string) => { matches: boolean } }): boolean {
  const w = win ?? (typeof window !== "undefined" ? window : undefined);
  if (!w || typeof w.matchMedia !== "function") return false;
  try {
    return Boolean(w.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}
