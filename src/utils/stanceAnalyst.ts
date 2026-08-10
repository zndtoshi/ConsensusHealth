/**
 * Stance-analyst privileges: provenance filters + avatar hover history.
 * Broader than manual editor (zndtoshi-only graph editing).
 */

const STANCE_ANALYST_HANDLES = new Set(["zndtoshi", "tonevays"]);

function normalizeHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

/** Authenticated users allowed to inspect stance provenance on the graph. */
export function isStanceAnalyst(handle: unknown): boolean {
  return STANCE_ANALYST_HANDLES.has(normalizeHandle(handle));
}

export function accountHasSelfReportedStance(account: {
  hasUserStanceChange?: unknown;
  has_user_stance_change?: unknown;
}): boolean {
  return Boolean(account?.hasUserStanceChange ?? account?.has_user_stance_change);
}

/** Seed/curated accounts that never logged in to change their own stance. */
export function filterSeedOnlyAccounts<T extends { hasUserStanceChange?: unknown; has_user_stance_change?: unknown }>(
  accounts: T[]
): T[] {
  return accounts.filter((a) => !accountHasSelfReportedStance(a));
}

/** Accounts whose stance was set (or changed) by the user themselves. */
export function filterSelfReportedAccounts<T extends { hasUserStanceChange?: unknown; has_user_stance_change?: unknown }>(
  accounts: T[]
): T[] {
  return accounts.filter((a) => accountHasSelfReportedStance(a));
}
