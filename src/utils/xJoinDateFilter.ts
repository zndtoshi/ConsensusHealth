/** X join-date year helpers and client-side graph filtering. */

export const X_JOIN_YEAR_FLOOR = 2006;

export function joinYearFromAccountCreatedAt(accountCreatedAt: unknown): number | null {
  if (accountCreatedAt == null || accountCreatedAt === "") return null;
  const d = new Date(String(accountCreatedAt));
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCFullYear();
}

export function clampJoinYear(year: number, minYear: number, maxYear: number): number {
  const y = Math.trunc(year);
  if (!Number.isFinite(y)) return minYear;
  return Math.min(maxYear, Math.max(minYear, y));
}

export function normalizeJoinYearRange(
  minYear: number,
  maxYear: number,
  boundMin: number,
  boundMax: number
): { minYear: number; maxYear: number } {
  const loBound = Math.min(boundMin, boundMax);
  const hiBound = Math.max(boundMin, boundMax);
  let lo = clampJoinYear(minYear, loBound, hiBound);
  let hi = clampJoinYear(maxYear, loBound, hiBound);
  if (lo > hi) {
    const mid = lo;
    lo = hi;
    hi = mid;
  }
  return { minYear: lo, maxYear: hi };
}

export type JoinDateAccountLike = {
  accountCreatedAt?: unknown;
  account_created_at?: unknown;
};

export function accountJoinYear(account: JoinDateAccountLike | null | undefined): number | null {
  if (!account) return null;
  return joinYearFromAccountCreatedAt(
    account.accountCreatedAt ?? account.account_created_at ?? null
  );
}

/** Inclusive year range. Unknown join dates are excluded while the filter is active. */
export function accountPassesJoinDateFilter(
  account: JoinDateAccountLike | null | undefined,
  enabled: boolean,
  minYear: number,
  maxYear: number
): boolean {
  if (!enabled) return true;
  const year = accountJoinYear(account);
  if (year == null) return false;
  return year >= minYear && year <= maxYear;
}

export function filterAccountsByJoinDate<T extends JoinDateAccountLike>(
  accounts: T[],
  enabled: boolean,
  minYear: number,
  maxYear: number
): T[] {
  if (!enabled) return accounts;
  return accounts.filter((a) => accountPassesJoinDateFilter(a, true, minYear, maxYear));
}

export function summarizeJoinDateYears(accounts: JoinDateAccountLike[]): {
  knownCount: number;
  unknownCount: number;
  earliestYear: number | null;
  latestYear: number | null;
} {
  let knownCount = 0;
  let unknownCount = 0;
  let earliestYear: number | null = null;
  let latestYear: number | null = null;
  for (const a of accounts) {
    const y = accountJoinYear(a);
    if (y == null) {
      unknownCount += 1;
      continue;
    }
    knownCount += 1;
    if (earliestYear == null || y < earliestYear) earliestYear = y;
    if (latestYear == null || y > latestYear) latestYear = y;
  }
  return { knownCount, unknownCount, earliestYear, latestYear };
}

/** Default slider bounds and initial handle positions when the filter is first enabled. */
export function defaultJoinDateRange(
  accounts: JoinDateAccountLike[],
  nowYear: number = new Date().getUTCFullYear()
): { boundMin: number; boundMax: number; minYear: number; maxYear: number } {
  const summary = summarizeJoinDateYears(accounts);
  const boundMin = X_JOIN_YEAR_FLOOR;
  const boundMax = Math.max(nowYear, summary.latestYear ?? nowYear);
  const minYear = summary.earliestYear ?? boundMin;
  const maxYear = summary.latestYear ?? boundMax;
  return {
    boundMin,
    boundMax,
    ...normalizeJoinYearRange(minYear, maxYear, boundMin, boundMax),
  };
}
