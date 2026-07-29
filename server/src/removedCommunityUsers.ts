/** Persist admin removals so seeded + DB users stay off the public graph. */

export type RemovedUserKey = {
  handle: string | null;
  xUserId: string | null;
};

export function normalizeRemovedHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export function normalizeRemovedXUserId(value: unknown): string {
  return String(value ?? "").trim();
}

/** True when a community row matches any removed handle or x_user_id. */
export function isRemovedCommunityUser(
  row: { handle?: unknown; x_user_id?: unknown; xUserId?: unknown },
  removed: { handles: Set<string>; xUserIds: Set<string> }
): boolean {
  const handle = normalizeRemovedHandle(row?.handle);
  const xUserId = normalizeRemovedXUserId(row?.x_user_id ?? row?.xUserId);
  if (handle && removed.handles.has(handle)) return true;
  if (xUserId && removed.xUserIds.has(xUserId)) return true;
  return false;
}

export function filterOutRemovedCommunityUsers<T extends { handle?: unknown; x_user_id?: unknown; xUserId?: unknown }>(
  rows: T[],
  removed: { handles: Set<string>; xUserIds: Set<string> }
): T[] {
  if (!removed.handles.size && !removed.xUserIds.size) return rows;
  return rows.filter((row) => !isRemovedCommunityUser(row, removed));
}

export function resolveRemovalTarget(input: {
  handle?: unknown;
  x_user_id?: unknown;
  requesterHandle?: unknown;
}): { ok: true; handle: string | null; xUserId: string | null } | { ok: false; error: string } {
  const handle = normalizeRemovedHandle(input.handle) || null;
  const xUserId = normalizeRemovedXUserId(input.x_user_id) || null;
  if (!handle && !xUserId) return { ok: false, error: "target_required" };
  const requester = normalizeRemovedHandle(input.requesterHandle);
  if (handle && requester && handle === requester) return { ok: false, error: "cannot_remove_self" };
  return { ok: true, handle, xUserId };
}
