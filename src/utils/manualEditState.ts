export type StanceValue = "against" | "neutral" | "approve";

type AccountRecord = {
  handle?: unknown;
  stance?: unknown;
  position?: unknown;
  [key: string]: unknown;
};

function normalizeHandle(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^@+/, "");
}

export function isPrivilegedManualEditor(handle: unknown): boolean {
  return normalizeHandle(handle) === "zndtoshi";
}

export function applyManualStanceUpdate<T extends AccountRecord>(
  accounts: T[],
  targetHandle: string,
  nextStance: StanceValue
): T[] {
  const target = normalizeHandle(targetHandle);
  if (!target) return accounts;
  let changed = false;
  const out = accounts.map((a) => {
    const h = normalizeHandle(a?.handle);
    if (h !== target) return a;
    changed = true;
    return {
      ...a,
      stance: nextStance,
      position: nextStance,
    };
  });
  return changed ? out : accounts;
}

/** Remove a user from the in-memory graph accounts list (by handle and/or x_user_id). */
export function removeAccountFromList<T extends AccountRecord>(
  accounts: T[],
  target: { handle?: unknown; x_user_id?: unknown }
): T[] {
  const handle = normalizeHandle(target.handle);
  const xUserId = String(target.x_user_id ?? "").trim();
  if (!handle && !xUserId) return accounts;
  const next = accounts.filter((a) => {
    const ah = normalizeHandle(a?.handle);
    const ax = String(a?.x_user_id ?? "").trim();
    if (handle && ah === handle) return false;
    if (xUserId && ax && ax === xUserId) return false;
    return true;
  });
  return next.length === accounts.length ? accounts : next;
}
