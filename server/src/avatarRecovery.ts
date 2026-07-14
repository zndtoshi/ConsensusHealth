/**
 * One-time avatar recovery orchestration for community users that have no
 * stored blob. Pure and dependency-injected: it takes candidate {x_user_id,
 * handle} rows and a `recoverOne` function (which scrapes + stores in
 * production), running with bounded concurrency and a polite per-item delay,
 * continuing past individual failures.
 */

export interface AvatarRecoveryCandidate {
  x_user_id: string;
  handle: string;
}

export type AvatarRecoveryStatus = "stored" | "exists" | "skipped" | "failed";

export type AvatarRecoveryOutcome = { status: AvatarRecoveryStatus; reason?: string };

export type RecoverOne = (candidate: AvatarRecoveryCandidate) => Promise<AvatarRecoveryOutcome>;

export interface AvatarRecoveryStats {
  total: number;
  stored: number;
  exists: number;
  skipped: number;
  failed: number;
}

export interface AvatarRecoveryLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 5;
const DEFAULT_CONCURRENCY = 3;

export function clampRecoveryConcurrency(value: number | undefined): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, n));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runAvatarRecovery(deps: {
  candidates: AvatarRecoveryCandidate[];
  recoverOne: RecoverOne;
  concurrency?: number;
  perItemDelayMs?: number;
  logger?: AvatarRecoveryLogger;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AvatarRecoveryStats> {
  const { candidates, recoverOne } = deps;
  const logger = deps.logger ?? console;
  const sleep = deps.sleep ?? defaultSleep;
  const concurrency = clampRecoveryConcurrency(deps.concurrency);
  const perItemDelayMs = Math.max(0, Number(deps.perItemDelayMs ?? 0));
  const stats: AvatarRecoveryStats = { total: candidates.length, stored: 0, exists: 0, skipped: 0, failed: 0 };

  logger.log(
    `[recover:avatars] candidates=${stats.total} concurrency=${concurrency} perItemDelayMs=${perItemDelayMs}`
  );

  let next = 0;

  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const index = next;
      next += 1;
      const candidate = candidates[index];
      const id = String(candidate?.x_user_id ?? "").trim();
      const handle = String(candidate?.handle ?? "").trim();
      if (!id || !handle) {
        stats.skipped += 1;
        continue;
      }
      try {
        const outcome = await recoverOne({ x_user_id: id, handle });
        switch (outcome.status) {
          case "stored":
            stats.stored += 1;
            break;
          case "exists":
            stats.exists += 1;
            break;
          case "skipped":
            stats.skipped += 1;
            break;
          case "failed":
            stats.failed += 1;
            logger.warn(`[recover:avatars] failed handle=@${handle} reason=${outcome.reason ?? "unknown"}`);
            break;
        }
      } catch (e) {
        stats.failed += 1;
        logger.error(`[recover:avatars] error handle=@${handle}`, e instanceof Error ? e.message : e);
      }
      if (perItemDelayMs > 0) await sleep(perItemDelayMs);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(0, candidates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  logger.log(
    `[recover:avatars] done total=${stats.total} stored=${stats.stored} exists=${stats.exists} ` +
      `skipped=${stats.skipped} failed=${stats.failed}`
  );
  return stats;
}
