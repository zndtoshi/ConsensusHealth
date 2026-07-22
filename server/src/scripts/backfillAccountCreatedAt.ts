/**
 * One-off backfill: permanently store X account creation dates via twitterapi.io.
 *
 * Env:
 *   TWITTERAPI_API_KEY  (required; Render already has this)
 *   DATABASE_URL        (required)
 *   JOIN_DATE_BACKFILL_CONCURRENCY=2
 *   JOIN_DATE_BACKFILL_DELAY_MS=500
 *
 * Commands:
 *   npm run backfill:join-dates -- --dry-run
 *   npm run backfill:join-dates -- --handle=zndtoshi --verbose
 *   npm run backfill:join-dates -- --limit=5
 *   npm run backfill:join-dates
 *
 * Production (compiled):
 *   npm run build:server
 *   npm run backfill:join-dates:prod -- --dry-run
 */

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  buildJoinDateCandidates,
  emptyJoinDateBackfillStats,
  estimateCredits,
  isNumericXUserId,
  normalizeHandle,
  parseBackfillArgs,
  type JoinDateCandidate,
  type RawAccountRow,
} from "../joinDateBackfill.js";
import {
  fetchProfileEnrichmentFromTwitterApiIo,
  fetchProfilesByIdsFromTwitterApiIo,
  resolveTwitterApiKey,
  type ProfileEnrichment,
} from "../profileEnrichment.js";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });
dotenv.config();

function fatal(msg: string): never {
  console.error(`\n[backfill:join-dates] ${msg}\n`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadSeedRows(): Promise<RawAccountRow[]> {
  const candidates = [
    path.resolve(process.cwd(), "public", "data", "accounts_stanced.json"),
    path.resolve(process.cwd(), "dist", "data", "accounts_stanced.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;
      return data.map((row) => ({ ...row, source: "seed" as const }));
    } catch {
      // try next
    }
  }
  return [];
}

async function runPool(
  items: JoinDateCandidate[],
  concurrency: number,
  worker: (item: JoinDateCandidate) => Promise<void>
): Promise<void> {
  let i = 0;
  async function loop() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]!);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => loop()));
}

async function persistJoinDate(
  pool: Pool,
  opts: {
    dbXUserId: string | null;
    resolvedId: string | null;
    handle: string | null;
    createdAt: string;
    dryRun: boolean;
  }
): Promise<"updated" | "skipped"> {
  const { dbXUserId, resolvedId, handle, createdAt, dryRun } = opts;
  if (dryRun) return "updated";

  const primaryId =
    (resolvedId && isNumericXUserId(resolvedId) && resolvedId) ||
    (dbXUserId && isNumericXUserId(dbXUserId) && dbXUserId) ||
    (handle ? `manual:${handle}` : null);
  if (!primaryId) return "skipped";

  // Prefer filling existing rows by stable id or handle — never overwrite dates.
  const updated = await pool.query(
    `
    UPDATE community_users
    SET
      account_created_at = COALESCE(account_created_at, $3::timestamptz),
      handle = COALESCE(NULLIF(handle, ''), $2),
      updated_at = NOW()
    WHERE account_created_at IS NULL
      AND (
        x_user_id = $1
        OR ($2::text IS NOT NULL AND lower(handle) = lower($2))
        OR ($2::text IS NOT NULL AND x_user_id = 'manual:' || lower($2))
      )
    `,
    [primaryId, handle, createdAt]
  );

  if ((updated.rowCount ?? 0) > 0) {
    // If we resolved a numeric id and an older manual:handle row exists, keep its date filled too.
    if (handle && isNumericXUserId(primaryId)) {
      await pool.query(
        `
        UPDATE community_users
        SET account_created_at = COALESCE(account_created_at, $2::timestamptz),
            updated_at = NOW()
        WHERE x_user_id = $1
          AND account_created_at IS NULL
        `,
        [`manual:${handle}`, createdAt]
      );
    }
    return "updated";
  }

  // Seed-only accounts: store join date without inventing stance/bio/followers.
  await pool.query(
    `
    INSERT INTO community_users (x_user_id, handle, account_created_at, updated_at)
    VALUES ($1, $2, $3::timestamptz, NOW())
    ON CONFLICT (x_user_id) DO UPDATE SET
      handle = COALESCE(NULLIF(EXCLUDED.handle, ''), community_users.handle),
      account_created_at = COALESCE(community_users.account_created_at, EXCLUDED.account_created_at),
      updated_at = NOW()
    WHERE community_users.account_created_at IS NULL
    `,
    [primaryId, handle, createdAt]
  );

  return "updated";
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  const apiKey = resolveTwitterApiKey();
  if (!args.dryRun && !apiKey) {
    fatal("TWITTERAPI_API_KEY is required (Render env var).");
  }

  const connectionString = (process.env.DATABASE_URL || "").trim();
  if (!connectionString && !args.dryRun) fatal("DATABASE_URL is required.");

  const concurrency = Math.max(
    1,
    Math.min(8, Number(process.env.JOIN_DATE_BACKFILL_CONCURRENCY || 2) || 2)
  );
  const delayMs = Math.max(
    0,
    Number(process.env.JOIN_DATE_BACKFILL_DELAY_MS || 500) || 500
  );

  const stats = emptyJoinDateBackfillStats();
  const pool = connectionString ? new Pool({ connectionString }) : null;

  try {
    const seedRows = await loadSeedRows();
    let dbRows: RawAccountRow[] = [];
    if (pool) {
      try {
        await pool.query(
          `ALTER TABLE community_users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;`
        );
        const res = await pool.query(
          `
          SELECT x_user_id, handle, account_created_at
          FROM community_users
          `
        );
        dbRows = res.rows.map((r) => ({
          x_user_id: r.x_user_id,
          handle: r.handle,
          account_created_at: r.account_created_at,
          source: "community" as const,
        }));
      } catch (e) {
        if (args.dryRun) {
          console.warn(
            "[backfill:join-dates] dry-run: database unavailable; using seed accounts only",
            String(e)
          );
        } else {
          throw e;
        }
      }
    }

    let candidates = buildJoinDateCandidates([...seedRows, ...dbRows]);
    if (args.handle) {
      candidates = candidates.filter((c) => c.handle === args.handle);
      if (!candidates.length) {
        candidates = [
          {
            dbXUserId: null,
            lookupXUserId: null,
            handle: args.handle,
            source: "seed",
            alreadyHasJoinDate: false,
          },
        ];
      }
    }

    stats.candidates = candidates.length;
    stats.alreadyPopulated = candidates.filter((c) => c.alreadyHasJoinDate).length;
    let missing = candidates.filter((c) => !c.alreadyHasJoinDate);
    if (args.limit != null) missing = missing.slice(0, args.limit);
    stats.toRequest = missing.length;

    const withNumericId = missing.filter((c) => c.lookupXUserId).length;
    const credits = estimateCredits(missing.length, withNumericId);

    console.log("[backfill:join-dates] summary", {
      keyEnv: "TWITTERAPI_API_KEY",
      dryRun: args.dryRun,
      handleFilter: args.handle,
      limit: args.limit,
      seedAccounts: seedRows.length,
      communityRows: dbRows.length,
      uniqueCandidates: stats.candidates,
      alreadyPopulated: stats.alreadyPopulated,
      toRequest: stats.toRequest,
      withNumericXUserId: withNumericId,
      estimatedCredits: `${credits.minCredits}–${credits.maxCredits}`,
      creditNote: credits.note,
      concurrency,
      delayMs,
    });

    if (args.dryRun) {
      console.log("[backfill:join-dates] dry-run complete (no API calls, no DB writes)");
      return;
    }

    if (!pool) fatal("DATABASE_URL is required for live runs.");
    if (!apiKey) fatal("TWITTERAPI_API_KEY is required (Render env var).");
    const key = apiKey;

    // Prefer batched id lookups when possible.
    const idBatch = missing.filter((c) => c.lookupXUserId);
    const handleOnly = missing.filter((c) => !c.lookupXUserId && c.handle);

    const applyEnrichment = async (
      candidate: JoinDateCandidate,
      enrichment: ProfileEnrichment | null
    ) => {
      if (!enrichment) {
        stats.permanentFailures += 1;
        return;
      }
      if (enrichment.unavailable) {
        stats.unavailable += 1;
        if (String(enrichment.unavailableReason || "").toLowerCase().includes("suspend")) {
          stats.suspended += 1;
        }
        return;
      }
      if (!enrichment.accountCreatedAt) {
        stats.malformed += 1;
        return;
      }
      if (
        enrichment.id &&
        candidate.lookupXUserId &&
        enrichment.id !== candidate.lookupXUserId
      ) {
        stats.identityConflicts += 1;
        console.warn("[backfill:join-dates] identity conflict", {
          handle: candidate.handle,
          expectedId: candidate.lookupXUserId,
          returnedId: enrichment.id,
        });
        return;
      }
      if (
        enrichment.username &&
        candidate.handle &&
        enrichment.username !== candidate.handle
      ) {
        // Handle rename: still accept if ids match or candidate had no id.
        if (candidate.lookupXUserId && enrichment.id === candidate.lookupXUserId) {
          // ok
        } else if (!candidate.lookupXUserId) {
          // ok — bind by returned id
        } else {
          stats.identityConflicts += 1;
          console.warn("[backfill:join-dates] handle mismatch", {
            expected: candidate.handle,
            returned: enrichment.username,
            id: enrichment.id,
          });
          return;
        }
      }

      const result = await persistJoinDate(pool, {
        dbXUserId: candidate.dbXUserId,
        resolvedId: enrichment.id,
        handle: enrichment.username || candidate.handle,
        createdAt: enrichment.accountCreatedAt,
        dryRun: false,
      });
      if (result === "updated") {
        stats.successfullyUpdated += 1;
        if (candidate.source === "seed" || candidate.source === "both") stats.seededUpdated += 1;
        if (candidate.source === "community" || candidate.source === "both") {
          stats.communityUpdated += 1;
        }
      }
    };

    // Batch numeric ids in chunks of 100.
    for (let i = 0; i < idBatch.length; i += 100) {
      const chunk = idBatch.slice(i, i + 100);
      const ids = chunk.map((c) => c.lookupXUserId!).filter(Boolean);
      try {
        stats.apiCalls += 1;
        const map = await fetchProfilesByIdsFromTwitterApiIo(ids, key, {
          onRateLimited: () => {
            stats.rateLimited += 1;
          },
        });
        for (const c of chunk) {
          const enr = c.lookupXUserId ? map.get(c.lookupXUserId) ?? null : null;
          if (args.verbose) {
            console.log("[backfill:join-dates][verbose]", {
              handle: c.handle,
              lookupXUserId: c.lookupXUserId,
              id: enr?.id ?? null,
              createdAt: enr?.accountCreatedAt ?? null,
              unavailable: enr?.unavailable ?? false,
            });
          }
          if (!enr && c.handle) {
            // Fallback single lookup by handle when id batch missed the user.
            stats.apiCalls += 1;
            const single = await fetchProfileEnrichmentFromTwitterApiIo(
              { xUserId: null, handle: c.handle },
              key,
              {
                onRateLimited: () => {
                  stats.rateLimited += 1;
                },
              }
            );
            if (args.verbose) {
              console.log("[backfill:join-dates][verbose][fallback]", {
                handle: c.handle,
                id: single?.id ?? null,
                createdAt: single?.accountCreatedAt ?? null,
              });
            }
            await applyEnrichment(c, single);
          } else {
            await applyEnrichment(c, enr);
          }
        }
      } catch (e) {
        stats.transientFailures += chunk.length;
        console.warn("[backfill:join-dates] id batch failed", String(e));
      }
      if (delayMs > 0) await sleep(delayMs);
      console.log("[backfill:join-dates] id-batch progress", {
        done: Math.min(i + 100, idBatch.length),
        total: idBatch.length,
        updated: stats.successfullyUpdated,
      });
    }

    await runPool(handleOnly, concurrency, async (c) => {
      try {
        stats.apiCalls += 1;
        const enr = await fetchProfileEnrichmentFromTwitterApiIo(
          { xUserId: null, handle: c.handle },
          key,
          {
            onRateLimited: () => {
              stats.rateLimited += 1;
            },
          }
        );
        if (args.verbose) {
          console.log("[backfill:join-dates][verbose]", {
            handle: c.handle,
            id: enr?.id ?? null,
            createdAt: enr?.accountCreatedAt ?? null,
            unavailable: enr?.unavailable ?? false,
          });
        }
        await applyEnrichment(c, enr);
      } catch (e) {
        stats.transientFailures += 1;
        console.warn("[backfill:join-dates] handle failed", c.handle, String(e));
      }
      if (delayMs > 0) await sleep(delayMs);
    });

    // Single-handle verbose path when only that filter was used and it was already in id batch.
    if (args.verbose && args.handle && missing.length === 1 && missing[0]?.lookupXUserId) {
      // already logged via apply; print final
      console.log("[backfill:join-dates][verbose] completed handle filter", args.handle);
    }

    console.log("[backfill:join-dates] done", stats);
  } finally {
    await pool?.end();
  }
}

main().catch((e) => {
  console.error("[backfill:join-dates] fatal", e);
  process.exit(1);
});
