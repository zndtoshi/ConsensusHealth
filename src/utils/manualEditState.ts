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

/** Clear public explanation when it no longer matches the account's current stance. */
export function publicExplanationForStance(
  explanation: unknown,
  currentStance: unknown
): Record<string, unknown> | null {
  if (!explanation || typeof explanation !== "object") return null;
  const verified = String((explanation as { stance_at_verification?: unknown }).stance_at_verification || "");
  const stance = String(currentStance || "");
  if (!verified || !stance || verified !== stance) return null;
  return explanation as Record<string, unknown>;
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
      // Keep server-owned explanation records for the owner, but hide mismatched
      // public DTOs from hover/selected surfaces immediately after stance edits.
      stance_explanation: publicExplanationForStance(a.stance_explanation, nextStance),
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
