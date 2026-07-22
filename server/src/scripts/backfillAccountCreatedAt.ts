/**
 * One-time backfill: fetch X account join dates (`created_at`) for community
 * users (and seed handles) that are missing `account_created_at`, and persist them.
 *
 * Uses twitterapi.io (TWITTERAPI_IO_KEY). Safe to re-run: existing dates are
 * never overwritten (COALESCE).
 *
 * Render shell (one-time):
 *   npm run backfill:join-dates
 *
 * Requires DATABASE_URL (set automatically on Render) and TWITTERAPI_IO_KEY.
 */

import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { fetchProfileEnrichmentFromTwitterApiIo } from "../profileEnrichment.js";

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
  const apiKey = (process.env.TWITTERAPI_IO_KEY || "").trim();
  if (!apiKey) fatal("TWITTERAPI_IO_KEY is required.");

  const delayMs = Math.max(0, Number(process.env.JOIN_DATE_BACKFILL_DELAY_MS || 250) || 250);
  const dryRun = String(process.env.DRY_RUN || "").trim() === "1";

  const pool = new Pool({ connectionString });
  try {
    await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;`);

    // Ensure seed handles exist as rows so join dates can be stored even if they
    // never logged in (manual:handle ids match prior enrichment scripts).
    const seedHandles = await loadSeedHandles();
    let seedUpserts = 0;
    for (const seed of seedHandles) {
      const xUserId = seed.xUserId && /^\d+$/.test(seed.xUserId) ? seed.xUserId : `manual:${seed.handle}`;
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
    console.log("[backfill:join-dates] seed rows touched:", seedUpserts, "from", seedHandles.length, "seed handles");

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
    console.log("[backfill:join-dates] missing account_created_at:", rows.length, dryRun ? "(dry-run)" : "");

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      processed += 1;
      const xUserId = String(row.x_user_id ?? "").trim();
      const handle = normalizeHandle(row.handle);
      const enrichmentId = /^\d+$/.test(xUserId) ? xUserId : "";
      try {
        const enrichment = await fetchProfileEnrichmentFromTwitterApiIo(
          { xUserId: enrichmentId || null, handle: handle || null },
          apiKey
        );
        const createdAt = enrichment?.accountCreatedAt ?? null;
        if (!createdAt) {
          skipped += 1;
          if (processed <= 15) {
            console.log("[backfill:join-dates] no date", { handle, x_user_id: xUserId });
          }
        } else if (dryRun) {
          updated += 1;
          if (processed <= 15) {
            console.log("[backfill:join-dates][dry-run] would set", { handle, x_user_id: xUserId, createdAt });
          }
        } else {
          const res = await pool.query(
            `
            UPDATE community_users
            SET account_created_at = COALESCE(account_created_at, $2::timestamptz),
                updated_at = NOW()
            WHERE x_user_id = $1
              AND account_created_at IS NULL
            `,
            [xUserId, createdAt]
          );
          if (Number(res.rowCount ?? 0) > 0) updated += 1;
          else skipped += 1;
        }
      } catch (e) {
        failed += 1;
        console.warn("[backfill:join-dates] failed", { handle, x_user_id: xUserId, error: String(e) });
      }

      if (processed % 25 === 0) {
        console.log("[backfill:join-dates] progress", { processed, updated, skipped, failed, total: rows.length });
      }
      if (delayMs > 0) await sleep(delayMs);
    }

    console.log("[backfill:join-dates] done", { processed, updated, skipped, failed, total: rows.length });
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[backfill:join-dates] fatal", e);
  process.exit(1);
});
