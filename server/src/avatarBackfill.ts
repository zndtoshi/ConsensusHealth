import type { EnsureAvatarResult } from "./avatarStore.js";

/**
 * One-time backfill orchestration. Pure and dependency-injected: it takes the
 * candidate rows and an `ensure` function (backed by the real provisioner in
 * production) and stores each avatar exactly once, with bounded concurrency,
 * continuing past individual failures. The DB/provisioner wiring lives in
 * `scripts/backfillAvatars.ts`.
 */

export interface AvatarBackfillCandidate {
  x_user_id: string;
  avatar_url: string | null;
}

export interface AvatarBackfillStats {
  total: number;
  stored: number;
  skipped: number;
  failed: number;
}

export type BackfillEnsure = (xUserId: string, imageUrl: string | null) => Promise<EnsureAvatarResult>;

export interface AvatarBackfillLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 5;
const DEFAULT_CONCURRENCY = 4;

export function clampConcurrency(value: number | undefined): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, n));
}

export async function runAvatarBackfill(deps: {
  candidates: AvatarBackfillCandidate[];
  ensure: BackfillEnsure;
  concurrency?: number;
  logger?: AvatarBackfillLogger;
}): Promise<AvatarBackfillStats> {
  const { candidates, ensure } = deps;
  const logger = deps.logger ?? console;
  const concurrency = clampConcurrency(deps.concurrency);
  const stats: AvatarBackfillStats = { total: candidates.length, stored: 0, skipped: 0, failed: 0 };

  logger.log(`[backfill:avatars] candidates=${stats.total} concurrency=${concurrency}`);

  // Shared cursor across workers. JavaScript is single-threaded and there is no
  // await between reading and advancing `next`, so this is race-free.
  let next = 0;

  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const index = next;
      next += 1;
      const candidate = candidates[index];
      const id = String(candidate?.x_user_id ?? "").trim();
      if (!id) {
        stats.skipped += 1;
        continue;
      }
      try {
        const result = await ensure(id, candidate.avatar_url ?? null);
        switch (result.status) {
          case "stored":
            stats.stored += 1;
            break;
          case "exists":
          case "skipped_no_url":
            stats.skipped += 1;
            break;
          case "failed":
            stats.failed += 1;
            logger.warn(`[backfill:avatars] failed x_user_id=${id} reason=${result.reason}`);
            break;
        }
      } catch (e) {
        // Continue past failures; never abort the whole backfill.
        stats.failed += 1;
        logger.error(`[backfill:avatars] error x_user_id=${id}`, e instanceof Error ? e.message : e);
      }
    }
  }

  const workerCount = Math.min(concurrency, Math.max(0, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  logger.log(
    `[backfill:avatars] done total=${stats.total} stored=${stats.stored} skipped=${stats.skipped} failed=${stats.failed}`
  );
  return stats;
}
