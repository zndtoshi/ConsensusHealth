/**
 * Shared join-date backfill logic (testable, no side effects until persist callbacks run).
 */

export type JoinDateCandidate = {
  /** Existing DB x_user_id (numeric or manual:handle). */
  dbXUserId: string | null;
  /** Preferred numeric X id for API lookup when known. */
  lookupXUserId: string | null;
  handle: string | null;
  source: "seed" | "community" | "both";
  alreadyHasJoinDate: boolean;
};

export type JoinDateBackfillStats = {
  candidates: number;
  alreadyPopulated: number;
  toRequest: number;
  successfullyUpdated: number;
  seededUpdated: number;
  communityUpdated: number;
  unavailable: number;
  suspended: number;
  malformed: number;
  rateLimited: number;
  transientFailures: number;
  permanentFailures: number;
  identityConflicts: number;
  apiCalls: number;
};

export function emptyJoinDateBackfillStats(): JoinDateBackfillStats {
  return {
    candidates: 0,
    alreadyPopulated: 0,
    toRequest: 0,
    successfullyUpdated: 0,
    seededUpdated: 0,
    communityUpdated: 0,
    unavailable: 0,
    suspended: 0,
    malformed: 0,
    rateLimited: 0,
    transientFailures: 0,
    permanentFailures: 0,
    identityConflicts: 0,
    apiCalls: 0,
  };
}

export function normalizeHandle(value: unknown): string | null {
  const h = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  return h || null;
}

export function isNumericXUserId(value: unknown): boolean {
  return /^\d+$/.test(String(value ?? "").trim());
}

export type RawAccountRow = {
  x_user_id?: unknown;
  xUserId?: unknown;
  handle?: unknown;
  username?: unknown;
  account_created_at?: unknown;
  accountCreatedAt?: unknown;
  source?: "seed" | "community";
};

/**
 * Build a deduplicated candidate list. Prefer stable numeric X user ID, then handle.
 */
export function buildJoinDateCandidates(rows: RawAccountRow[]): JoinDateCandidate[] {
  type Acc = {
    dbXUserId: string | null;
    lookupXUserId: string | null;
    handle: string | null;
    sources: Set<"seed" | "community">;
    alreadyHasJoinDate: boolean;
  };
  const byId = new Map<string, Acc>();
  const byHandle = new Map<string, Acc>();

  const hasDate = (row: RawAccountRow): boolean => {
    const raw = row.account_created_at ?? row.accountCreatedAt;
    if (!raw) return false;
    const d = new Date(String(raw));
    return Number.isFinite(d.getTime());
  };

  for (const row of rows) {
    const handle = normalizeHandle(row.handle ?? row.username);
    const rawId = String(row.x_user_id ?? row.xUserId ?? "").trim() || null;
    const numericId = rawId && isNumericXUserId(rawId) ? rawId : null;
    const source = row.source === "community" ? "community" : "seed";
    const already = hasDate(row);

    let acc: Acc | undefined;
    if (numericId) acc = byId.get(numericId);
    if (!acc && handle) acc = byHandle.get(handle);

    if (!acc) {
      acc = {
        dbXUserId: rawId,
        lookupXUserId: numericId,
        handle,
        sources: new Set([source]),
        alreadyHasJoinDate: already,
      };
      if (numericId) byId.set(numericId, acc);
      if (handle) byHandle.set(handle, acc);
      continue;
    }

    acc.sources.add(source);
    acc.alreadyHasJoinDate = acc.alreadyHasJoinDate || already;
    if (handle && !acc.handle) acc.handle = handle;
    if (numericId) {
      if (acc.lookupXUserId && acc.lookupXUserId !== numericId) {
        // Conflict tracked by caller via separate pass; keep first.
      } else {
        acc.lookupXUserId = numericId;
      }
      if (!acc.dbXUserId || !isNumericXUserId(acc.dbXUserId)) acc.dbXUserId = numericId;
      byId.set(numericId, acc);
      if (handle) byHandle.set(handle, acc);
    } else if (rawId && !acc.dbXUserId) {
      acc.dbXUserId = rawId;
    }
    if (handle) byHandle.set(handle, acc);
  }

  const seen = new Set<Acc>();
  const out: JoinDateCandidate[] = [];
  for (const acc of [...byId.values(), ...byHandle.values()]) {
    if (seen.has(acc)) continue;
    seen.add(acc);
    if (!acc.lookupXUserId && !acc.handle) continue;
    const source: JoinDateCandidate["source"] =
      acc.sources.has("seed") && acc.sources.has("community")
        ? "both"
        : acc.sources.has("community")
          ? "community"
          : "seed";
    out.push({
      dbXUserId: acc.dbXUserId,
      lookupXUserId: acc.lookupXUserId,
      handle: acc.handle,
      source,
      alreadyHasJoinDate: acc.alreadyHasJoinDate,
    });
  }
  return out;
}

export function parseBackfillArgs(argv: string[]): {
  dryRun: boolean;
  limit: number | null;
  handle: string | null;
  verbose: boolean;
} {
  let dryRun = false;
  let limit: number | null = null;
  let handle: string | null = null;
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    } else if (arg.startsWith("--handle=")) {
      handle = normalizeHandle(arg.slice("--handle=".length));
    }
  }
  return { dryRun, limit, handle, verbose };
}

export function estimateCredits(toRequest: number, withNumericId: number): {
  minCredits: number;
  maxCredits: number;
  note: string;
} {
  // Docs: single ~18 credits; bulk 100+ users ~10 credits/user.
  const byHandle = Math.max(0, toRequest - withNumericId);
  const byId = withNumericId;
  const minCredits = byId * 10 + byHandle * 10;
  const maxCredits = byId * 18 + byHandle * 18;
  return {
    minCredits,
    maxCredits,
    note: "twitterapi.io: ~10–18 credits per profile depending on batch size",
  };
}
