/**
 * Shared join-date backfill logic (testable, no side effects until persist callbacks run).
 */

import {
  coerceXUserIdKey,
  coerceXUserIdToDigitString,
  isDigitOnlyXUserId,
  isUnsafeOrRoundedXUserId,
  knownRoundedRecordForHandle,
  normalizeHandle,
  KNOWN_ROUNDED_X_USER_IDS,
} from "./xUserId.js";

export {
  normalizeHandle,
  isDigitOnlyXUserId as isNumericXUserId,
  coerceXUserIdToDigitString,
  isUnsafeOrRoundedXUserId,
  knownRoundedRecordForHandle,
  KNOWN_ROUNDED_X_USER_IDS,
  evaluateRoundedIdRepair,
} from "./xUserId.js";
export type { RoundedIdRepairDecision, RoundedIdRepairInput } from "./xUserId.js";

export type JoinDateCandidate = {
  /** Existing DB x_user_id (digit string or manual:handle). */
  dbXUserId: string | null;
  /** Preferred digit X id for API lookup when known and safe. */
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
  repairedRoundedIds: number;
  skippedAmbiguous: number;
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
    repairedRoundedIds: 0,
    skippedAmbiguous: 0,
    apiCalls: 0,
  };
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
 * Build a deduplicated candidate list. Prefer stable digit X user ID, then handle.
 * JS numbers are ignored (may be rounded); only string/bigint digit IDs are used.
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
    const digitId = coerceXUserIdToDigitString(row.x_user_id ?? row.xUserId);
    const rawKey = coerceXUserIdKey(row.x_user_id ?? row.xUserId);
    const source = row.source === "community" ? "community" : "seed";
    const already = hasDate(row);

    let acc: Acc | undefined;
    if (digitId) acc = byId.get(digitId);
    if (!acc && handle) acc = byHandle.get(handle);

    if (!acc) {
      acc = {
        dbXUserId: rawKey,
        lookupXUserId: digitId,
        handle,
        sources: new Set([source]),
        alreadyHasJoinDate: already,
      };
      if (digitId) byId.set(digitId, acc);
      if (handle) byHandle.set(handle, acc);
      continue;
    }

    acc.sources.add(source);
    acc.alreadyHasJoinDate = acc.alreadyHasJoinDate || already;
    if (handle && !acc.handle) acc.handle = handle;
    if (digitId) {
      if (acc.lookupXUserId && acc.lookupXUserId !== digitId) {
        // Conflict tracked by caller via separate pass; keep first.
      } else {
        acc.lookupXUserId = digitId;
      }
      if (!acc.dbXUserId || !isDigitOnlyXUserId(acc.dbXUserId)) acc.dbXUserId = digitId;
      byId.set(digitId, acc);
      if (handle) byHandle.set(handle, acc);
    } else if (rawKey && !acc.dbXUserId) {
      acc.dbXUserId = rawKey;
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

/** Candidates that look like rounded-ID repair targets (for dry-run reporting). */
export function listKnownRoundedRepairCandidates(candidates: JoinDateCandidate[]): Array<{
  handle: string;
  storedId: string | null;
  expectedExactId: string | null;
  alreadyHasJoinDate: boolean;
}> {
  const out: Array<{
    handle: string;
    storedId: string | null;
    expectedExactId: string | null;
    alreadyHasJoinDate: boolean;
  }> = [];
  const seen = new Set<string>();

  for (const known of KNOWN_ROUNDED_X_USER_IDS) {
    const hit = candidates.find((c) => c.handle === known.handle);
    const stored = hit?.dbXUserId ?? hit?.lookupXUserId ?? known.roundedId;
    const already = hit?.alreadyHasJoinDate ?? false;
    if (already && stored === known.exactId) continue;
    out.push({
      handle: known.handle,
      storedId: stored,
      expectedExactId: known.exactId,
      alreadyHasJoinDate: already,
    });
    seen.add(known.handle);
  }

  for (const c of candidates) {
    if (!c.handle || seen.has(c.handle) || c.alreadyHasJoinDate) continue;
    const stored = c.dbXUserId ?? c.lookupXUserId;
    if (!stored || !isUnsafeOrRoundedXUserId(stored)) continue;
    out.push({
      handle: c.handle,
      storedId: stored,
      expectedExactId: null,
      alreadyHasJoinDate: false,
    });
  }

  return out.sort((a, b) => a.handle.localeCompare(b.handle));
}

export function parseBackfillArgs(argv: string[]): {
  dryRun: boolean;
  limit: number | null;
  handle: string | null;
  verbose: boolean;
  repairRoundedIds: boolean;
} {
  let dryRun = false;
  let limit: number | null = null;
  let handle: string | null = null;
  let verbose = false;
  let repairRoundedIds = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--repair-rounded-ids") repairRoundedIds = true;
    else if (arg.startsWith("--limit=")) {
      const n = Number(arg.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    } else if (arg.startsWith("--handle=")) {
      handle = normalizeHandle(arg.slice("--handle=".length));
    }
  }
  return { dryRun, limit, handle, verbose, repairRoundedIds };
}

export function estimateCredits(toRequest: number, withNumericId: number): {
  minCredits: number;
  maxCredits: number;
  note: string;
} {
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
