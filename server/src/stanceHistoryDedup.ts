import { encodeStanceHistoryCursor, type StanceHistoryCursor } from "./stanceHistory.js";

/**
 * Minimal shape needed to select the latest stance event per user.
 * `x_user_id` is the stable internal user id used for deduplication (NOT handle,
 * because handles can change). `changed_at` must be an ISO-8601 string.
 */
export type DedupableStanceEvent = {
  id: number;
  x_user_id: string;
  changed_at: string;
};

function isNewer(a: DedupableStanceEvent, b: DedupableStanceEvent): boolean {
  const at = Date.parse(a.changed_at);
  const bt = Date.parse(b.changed_at);
  if (at !== bt) return at > bt;
  // Deterministic tie-breaker on equal timestamps: higher unique event id wins.
  return a.id > b.id;
}

function isBeforeCursor(e: DedupableStanceEvent, cursor: StanceHistoryCursor): boolean {
  const et = Date.parse(e.changed_at);
  const ct = Date.parse(cursor.changed_at);
  if (et !== ct) return et < ct;
  return e.id < cursor.id;
}

/**
 * Pure, in-memory mirror of the SQL used by `queryRecentStanceHistoryPage`:
 * keep only each user's latest event (newest `changed_at`, then highest `id`),
 * order newest-to-oldest, then apply cursor pagination AFTER deduplication.
 *
 * The database performs this via `ROW_NUMBER() OVER (PARTITION BY x_user_id ...)`.
 * This function exists to document and test the exact contract.
 */
export function selectLatestStanceEventsPerUser<T extends DedupableStanceEvent>(
  events: T[],
  opts: { limit: number; cursor?: StanceHistoryCursor | null }
): { items: T[]; next_cursor: string | null; has_more: boolean } {
  const latestByUser = new Map<string, T>();
  for (const e of events) {
    const existing = latestByUser.get(e.x_user_id);
    if (!existing || isNewer(e, existing)) latestByUser.set(e.x_user_id, e);
  }

  let ordered = [...latestByUser.values()].sort((a, b) => (isNewer(a, b) ? -1 : 1));

  if (opts.cursor) {
    ordered = ordered.filter((e) => isBeforeCursor(e, opts.cursor as StanceHistoryCursor));
  }

  const limit = Math.max(1, Math.min(50, Math.trunc(opts.limit) || 10));
  const has_more = ordered.length > limit;
  const items = has_more ? ordered.slice(0, limit) : ordered;
  const last = items[items.length - 1];
  const next_cursor =
    has_more && last
      ? encodeStanceHistoryCursor({ changed_at: last.changed_at, id: last.id })
      : null;

  return { items, next_cursor, has_more };
}
