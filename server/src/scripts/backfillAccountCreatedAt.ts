/**
 * One-time backfill: fetch X account join dates (`created_at`) for community
 * users (and seed handles) missing `account_created_at`, and persist them.
 *
 * Uses the official X API v2 (same app credentials as login) — no twitterapi.io.
 * Auth: X_BEARER_TOKEN, or X_CLIENT_ID + X_CLIENT_SECRET (client credentials).
 *
 * Render shell (one-time):
 *   npm run backfill:join-dates
 *
 * Requires DATABASE_URL (set on Render) and X app credentials already used for OAuth.
 */

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  fetchXUsersByIds,
  fetchXUsersByUsernames,
  getXAppBearerToken,
} from "../xApiUsers.js";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });
dotenv.config();

function fatal(msg: string): never {
  console.error(`\n[backfill:join-dates] ${msg}\n`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

async function loadSeedHandles(): Promise<Array<{ handle: string; xUserId: string | null }>> {
  const candidates = [
    path.resolve(process.cwd(), "public", "data", "accounts_stanced.json"),
    path.resolve(process.cwd(), "dist", "data", "accounts_stanced.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf-8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;
      const out: Array<{ handle: string; xUserId: string | null }> = [];
      for (const row of data) {
        const handle = normalizeHandle(row?.handle ?? row?.username);
        if (!handle) continue;
        const xUserId = String(row?.x_user_id ?? row?.xUserId ?? "").trim() || null;
        out.push({ handle, xUserId });
      }
      return out;
    } catch {
      // try next
    }
  }
  return [];
}

async function main(): Promise<void> {
  const connectionString = (process.env.DATABASE_URL || "").trim();
  if (!connectionString) fatal("DATABASE_URL is required.");

  const delayMs = Math.max(0, Number(process.env.JOIN_DATE_BACKFILL_DELAY_MS || 500) || 500);
  const dryRun = String(process.env.DRY_RUN || "").trim() === "1";

  let bearer: string;
  try {
    bearer = await getXAppBearerToken();
  } catch (e) {
    fatal(String((e as Error)?.message || e));
  }

  const pool = new Pool({ connectionString });
  try {
    await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;`);

    const seedHandles = await loadSeedHandles();
    let seedUpserts = 0;
    for (const seed of seedHandles) {
      const xUserId =
        seed.xUserId && /^\d+$/.test(seed.xUserId) ? seed.xUserId : `manual:${seed.handle}`;
      if (dryRun) {
        seedUpserts += 1;
        continue;
      }
      const res = await pool.query(
        `
        INSERT INTO community_users (x_user_id, handle, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (x_user_id) DO UPDATE SET
          handle = COALESCE(NULLIF(EXCLUDED.handle, ''), community_users.handle)
        WHERE community_users.handle IS NULL OR community_users.handle = ''
        `,
        [xUserId, seed.handle]
      );
      seedUpserts += Number(res.rowCount ?? 0);
    }
    console.log(
      "[backfill:join-dates] seed rows touched:",
      seedUpserts,
      "from",
      seedHandles.length,
      "seed handles"
    );

    const missing = await pool.query<{
      x_user_id: string;
      handle: string | null;
    }>(
      `
      SELECT x_user_id, handle
      FROM community_users
      WHERE account_created_at IS NULL
        AND (
          (handle IS NOT NULL AND length(trim(handle)) > 0)
          OR (x_user_id ~ '^[0-9]+$')
        )
      ORDER BY updated_at DESC NULLS LAST, id ASC
      `
    );

    const rows = missing.rows;
    console.log(
      "[backfill:join-dates] missing account_created_at:",
      rows.length,
      dryRun ? "(dry-run)" : "",
      "(via X API)"
    );

    const byId: string[] = [];
    const byHandle: Array<{ xUserId: string; handle: string }> = [];
    for (const row of rows) {
      const xUserId = String(row.x_user_id ?? "").trim();
      const handle = normalizeHandle(row.handle);
      if (/^\d+$/.test(xUserId)) byId.push(xUserId);
      else if (handle) byHandle.push({ xUserId, handle });
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    // Batch by numeric X user id (100 / request).
    for (let i = 0; i < byId.length; i += 100) {
      const chunk = byId.slice(i, i + 100);
      try {
        const profiles = await fetchXUsersByIds(bearer, chunk);
        for (const id of chunk) {
          const createdAt = profiles.get(id)?.createdAt ?? null;
          if (!createdAt) {
            skipped += 1;
            continue;
          }
          if (dryRun) {
            updated += 1;
            continue;
          }
          const res = await pool.query(
            `
            UPDATE community_users
            SET account_created_at = COALESCE(account_created_at, $2::timestamptz),
                updated_at = NOW()
            WHERE x_user_id = $1
              AND account_created_at IS NULL
            `,
            [id, createdAt]
          );
          if (Number(res.rowCount ?? 0) > 0) updated += 1;
          else skipped += 1;
        }
      } catch (e) {
        failed += chunk.length;
        console.warn("[backfill:join-dates] id-batch failed", {
          from: i,
          size: chunk.length,
          error: String(e),
        });
      }
      console.log("[backfill:join-dates] id progress", {
        done: Math.min(i + 100, byId.length),
        total: byId.length,
        updated,
        skipped,
        failed,
      });
      if (delayMs > 0) await sleep(delayMs);
    }

    // Batch by handle for manual:* rows (100 / request).
    for (let i = 0; i < byHandle.length; i += 100) {
      const chunk = byHandle.slice(i, i + 100);
      try {
        const profiles = await fetchXUsersByUsernames(
          bearer,
          chunk.map((c) => c.handle)
        );
        for (const row of chunk) {
          const createdAt = profiles.get(row.handle)?.createdAt ?? null;
          if (!createdAt) {
            skipped += 1;
            continue;
          }
          if (dryRun) {
            updated += 1;
            continue;
          }
          const res = await pool.query(
            `
            UPDATE community_users
            SET account_created_at = COALESCE(account_created_at, $2::timestamptz),
                updated_at = NOW()
            WHERE x_user_id = $1
              AND account_created_at IS NULL
            `,
            [row.xUserId, createdAt]
          );
          if (Number(res.rowCount ?? 0) > 0) updated += 1;
          else skipped += 1;
        }
      } catch (e) {
        failed += chunk.length;
        console.warn("[backfill:join-dates] handle-batch failed", {
          from: i,
          size: chunk.length,
          error: String(e),
        });
      }
      console.log("[backfill:join-dates] handle progress", {
        done: Math.min(i + 100, byHandle.length),
        total: byHandle.length,
        updated,
        skipped,
        failed,
      });
      if (delayMs > 0) await sleep(delayMs);
    }

    console.log("[backfill:join-dates] done", {
      totalMissing: rows.length,
      updated,
      skipped,
      failed,
      via: "X API v2",
    });
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[backfill:join-dates] fatal", e);
  process.exit(1);
});
