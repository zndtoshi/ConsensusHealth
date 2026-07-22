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
 *   npm run backfill:join-dates -- --repair-rounded-ids --verbose
 *   npm run backfill:join-dates -- --repair-rounded-ids --dry-run
 *   npm run backfill:join-dates
 *
 * Production (compiled):
 *   npm run build:server
 *   npm run backfill:join-dates:prod -- --repair-rounded-ids --verbose
 */

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  buildJoinDateCandidates,
  emptyJoinDateBackfillStats,
  estimateCredits,
  evaluateRoundedIdRepair,
  isNumericXUserId,
  isUnsafeOrRoundedXUserId,
  listKnownRoundedRepairCandidates,
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
import { parseJsonPreservingSnowflakeIds } from "../xUserId.js";

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
      const data = parseJsonPreservingSnowflakeIds(raw);
      if (!Array.isArray(data)) continue;
      return data.map((row) => ({ ...(row as object), source: "seed" as const }));
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

async function exactIdOwnedByOtherRow(
  pool: Pool,
  exactId: string,
  excludeIds: Array<string | null | undefined>
): Promise<boolean> {
  const excluded = [...new Set(excludeIds.map((x) => String(x || "").trim()).filter(Boolean))];
  const res = await pool.query(
    `
    SELECT x_user_id
    FROM community_users
    WHERE x_user_id = $1
      AND NOT (x_user_id = ANY($2::text[]))
    LIMIT 1
    `,
    [exactId, excluded]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Remap a rounded x_user_id to the exact TwitterAPI.io id and set account_created_at.
 * Does not touch stance, history content, avatar_path, followers, name, or provenance fields
 * beyond rewriting FK x_user_id keys to the new primary key.
 */
async function repairRoundedIdAndJoinDate(
  pool: Pool,
  opts: {
    oldId: string;
    newId: string;
    handle: string;
    createdAt: string;
    dryRun: boolean;
  }
): Promise<"updated" | "skipped"> {
  const { oldId, newId, handle, createdAt, dryRun } = opts;
  if (dryRun) return "updated";
  if (!isNumericXUserId(oldId) || !isNumericXUserId(newId) || oldId === newId) return "skipped";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `
      SELECT x_user_id, account_created_at
      FROM community_users
      WHERE x_user_id = $1
         OR lower(handle) = lower($2)
      LIMIT 1
      `,
      [oldId, handle]
    );
    const row = current.rows[0] as
      | { x_user_id: string; account_created_at: string | null }
      | undefined;
    if (!row) {
      await client.query("ROLLBACK");
      return "skipped";
    }
    if (row.account_created_at != null) {
      await client.query("ROLLBACK");
      return "skipped";
    }

    const fromId = String(row.x_user_id);
    if (fromId === newId) {
      await client.query(
        `
        UPDATE community_users
        SET account_created_at = COALESCE(account_created_at, $2::timestamptz),
            updated_at = NOW()
        WHERE x_user_id = $1 AND account_created_at IS NULL
        `,
        [newId, createdAt]
      );
      await client.query("COMMIT");
      return "updated";
    }

    const clash = await client.query(
      `SELECT 1 FROM community_users WHERE x_user_id = $1 LIMIT 1`,
      [newId]
    );
    if ((clash.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return "skipped";
    }

    // Child tables that key by x_user_id (stance_history has FK ON DELETE CASCADE).
    await client.query(`UPDATE stance_history SET x_user_id = $2 WHERE x_user_id = $1`, [
      fromId,
      newId,
    ]);
    await client.query(`UPDATE stance_events SET x_user_id = $2 WHERE x_user_id = $1`, [
      fromId,
      newId,
    ]);
    await client.query(`UPDATE sessions SET x_user_id = $2 WHERE x_user_id = $1`, [fromId, newId]);

    await client.query(
      `
      UPDATE community_users
      SET
        x_user_id = $2,
        account_created_at = COALESCE(account_created_at, $3::timestamptz),
        updated_at = NOW()
      WHERE x_user_id = $1
        AND account_created_at IS NULL
      `,
      [fromId, newId, createdAt]
    );

    await client.query("COMMIT");
    console.log("[backfill:join-dates] repaired rounded x_user_id", {
      handle,
      oldId: fromId,
      newId,
      account_created_at: createdAt,
    });
    return "updated";
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    client.release();
  }
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
  const delayMs = Math.max(0, Number(process.env.JOIN_DATE_BACKFILL_DELAY_MS || 500) || 500);

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

    if (args.repairRoundedIds) {
      const repairReport = listKnownRoundedRepairCandidates(candidates).filter((r) =>
        args.handle ? r.handle === args.handle : true
      );
      console.log("[backfill:join-dates] repair-rounded-ids candidates", repairReport);
    }

    // In repair mode, never look up by possibly-rounded IDs — handle only.
    const idBatch = args.repairRoundedIds
      ? []
      : missing.filter((c) => c.lookupXUserId && !isUnsafeOrRoundedXUserId(c.lookupXUserId));
    const handleOnly = args.repairRoundedIds
      ? missing.filter((c) => Boolean(c.handle))
      : missing.filter(
          (c) =>
            Boolean(c.handle) &&
            (!c.lookupXUserId || isUnsafeOrRoundedXUserId(c.lookupXUserId))
        );

    const withNumericId = idBatch.length;
    const credits = estimateCredits(missing.length, withNumericId);

    console.log("[backfill:join-dates] summary", {
      keyEnv: "TWITTERAPI_API_KEY",
      dryRun: args.dryRun,
      repairRoundedIds: args.repairRoundedIds,
      handleFilter: args.handle,
      limit: args.limit,
      seedAccounts: seedRows.length,
      communityRows: dbRows.length,
      uniqueCandidates: stats.candidates,
      alreadyPopulated: stats.alreadyPopulated,
      toRequest: stats.toRequest,
      withNumericXUserId: withNumericId,
      handleLookups: handleOnly.length,
      estimatedCredits: `${credits.minCredits}–${credits.maxCredits}`,
      creditNote: credits.note,
      concurrency,
      delayMs,
      pgXUserIdType: "TEXT",
    });

    if (args.dryRun) {
      console.log("[backfill:join-dates] dry-run complete (no API calls, no DB writes)");
      return;
    }

    if (!pool) fatal("DATABASE_URL is required for live runs.");
    if (!apiKey) fatal("TWITTERAPI_API_KEY is required (Render env var).");
    const key = apiKey;

    const applyEnrichment = async (
      candidate: JoinDateCandidate,
      enrichment: ProfileEnrichment | null,
      lookupWasByHandle: boolean
    ) => {
      if (!enrichment) {
        stats.permanentFailures += 1;
        if (candidate.handle === "arberash") {
          console.warn("[backfill:join-dates] arberash unresolved", {
            reason: "not_returned_by_twitterapi_io",
          });
        }
        return;
      }
      if (enrichment.unavailable) {
        stats.unavailable += 1;
        const reason = String(enrichment.unavailableReason || "").toLowerCase();
        if (reason.includes("suspend")) stats.suspended += 1;
        if (candidate.handle === "arberash") {
          console.warn("[backfill:join-dates] arberash unresolved", {
            unavailable: true,
            unavailableReason: enrichment.unavailableReason,
            suspended: reason.includes("suspend"),
            deleted: reason.includes("delet") || reason.includes("not exist"),
            renamed: false,
          });
        }
        return;
      }
      if (!enrichment.accountCreatedAt) {
        stats.malformed += 1;
        if (candidate.handle === "arberash") {
          console.warn("[backfill:join-dates] arberash unresolved", {
            reason: "returned_without_created_at",
            id: enrichment.id,
            username: enrichment.username,
          });
        }
        return;
      }

      const storedId = candidate.dbXUserId ?? candidate.lookupXUserId;
      const idsDiffer =
        Boolean(enrichment.id) &&
        Boolean(storedId) &&
        isNumericXUserId(String(storedId)) &&
        enrichment.id !== storedId;

      if (idsDiffer) {
        const owned =
          enrichment.id && pool
            ? await exactIdOwnedByOtherRow(pool, enrichment.id, [storedId, candidate.dbXUserId])
            : false;
        const decision = evaluateRoundedIdRepair({
          repairRoundedIdsEnabled: args.repairRoundedIds,
          lookupWasByHandle,
          requestedHandle: candidate.handle,
          returnedHandle: enrichment.username,
          storedId: storedId && isNumericXUserId(storedId) ? storedId : null,
          returnedId: enrichment.id,
          joinDateIsNull: !candidate.alreadyHasJoinDate,
          accountCreatedAt: enrichment.accountCreatedAt,
          exactIdOwnedByOtherRow: owned,
        });

        if (decision.action === "repair") {
          const result = await repairRoundedIdAndJoinDate(pool, {
            oldId: decision.oldId,
            newId: decision.newId,
            handle: decision.handle,
            createdAt: decision.createdAt,
            dryRun: false,
          });
          if (result === "updated") {
            stats.successfullyUpdated += 1;
            stats.repairedRoundedIds += 1;
            if (candidate.source === "seed" || candidate.source === "both") stats.seededUpdated += 1;
            if (candidate.source === "community" || candidate.source === "both") {
              stats.communityUpdated += 1;
            }
          } else {
            stats.skippedAmbiguous += 1;
            console.warn("[backfill:join-dates] repair skipped (ambiguous/race)", decision);
          }
          return;
        }

        if (decision.action === "reject_conflict") {
          stats.identityConflicts += 1;
          console.warn("[backfill:join-dates] identity conflict", {
            handle: candidate.handle,
            expectedId: storedId,
            returnedId: enrichment.id,
            reason: decision.reason,
          });
          return;
        }

        if (decision.action === "skip") {
          stats.skippedAmbiguous += 1;
          console.warn("[backfill:join-dates] skip ambiguous identity", {
            handle: candidate.handle,
            reason: decision.reason,
          });
          return;
        }
        // accept_without_id_change falls through to normal persist
      } else if (
        enrichment.username &&
        candidate.handle &&
        enrichment.username !== candidate.handle
      ) {
        if (candidate.lookupXUserId && enrichment.id === candidate.lookupXUserId) {
          // ok — rename with matching id
        } else if (!candidate.lookupXUserId || args.repairRoundedIds) {
          // handle-only or repair path: require matching handle (already checked above for repair)
          if (enrichment.username !== candidate.handle) {
            stats.identityConflicts += 1;
            console.warn("[backfill:join-dates] handle mismatch", {
              expected: candidate.handle,
              returned: enrichment.username,
              id: enrichment.id,
            });
            return;
          }
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
            await applyEnrichment(c, single, true);
          } else {
            await applyEnrichment(c, enr, false);
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
            unavailableReason: enr?.unavailableReason ?? null,
          });
        }
        await applyEnrichment(c, enr, true);
      } catch (e) {
        stats.transientFailures += 1;
        console.warn("[backfill:join-dates] handle failed", c.handle, String(e));
      }
      if (delayMs > 0) await sleep(delayMs);
    });

    if (args.verbose && args.handle && missing.length === 1) {
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
