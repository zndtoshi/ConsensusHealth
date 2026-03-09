import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { fetchProfileEnrichmentFromTwitterApiIo } from "./profileEnrichment.js";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });

const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const TWITTERAPI_IO_KEY = (process.env.TWITTERAPI_IO_KEY || "").trim();

function fatal(msg: string): never {
  console.error(`\n[enrich:profiles] ${msg}\n`);
  process.exit(1);
}

function validateDatabaseUrl(raw: string): void {
  const value = String(raw || "").trim();
  if (!value) {
    fatal("DATABASE_URL is missing. Fix server/.env formatting and value.");
  }
  const suspiciousFragments = [
    "APP_ORIGIN=",
    "PORT=",
    "SESSION_SECRET=",
    "FRONTEND_BASE_URL=",
    "X_CLIENT_ID=",
    "X_CLIENT_SECRET=",
    "TWITTERAPI_IO_KEY=",
  ];
  for (const fragment of suspiciousFragments) {
    if (value.includes(fragment)) {
      fatal(
        `DATABASE_URL appears malformed (contains '${fragment}'). ` +
        "Likely missing newline in server/.env. Put each KEY=VALUE on its own line."
      );
    }
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol.startsWith("postgres")) {
      fatal("DATABASE_URL must use postgres/postgresql protocol.");
    }
  } catch {
    fatal("DATABASE_URL is not a valid URL. Check server/.env formatting.");
  }
}

function resolveConnectionString(): string {
  if (DATABASE_URL) {
    validateDatabaseUrl(DATABASE_URL);
    return DATABASE_URL;
  }
  const PGHOST = (process.env.PGHOST || "localhost").trim();
  const PGPORT = (process.env.PGPORT || "5432").trim();
  const PGDATABASE = (process.env.PGDATABASE || "consensushealth").trim();
  const PGUSER = (process.env.PGUSER || "postgres").trim();
  const PGPASSWORD = (process.env.PGPASSWORD || "").trim();
  if (!PGPASSWORD) fatal("DATABASE_URL missing and PGPASSWORD missing.");
  return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type InputUser = {
  x_user_id?: string | null;
  handle?: string | null;
  username?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  followers_count?: number | string | null;
  bio?: string | null;
  description?: string | null;
  account_created_at?: string | null;
  accountCreatedAt?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
};

async function ensureSchemaColumns(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS bio TEXT;`);
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;`);
}

function normalizeBio(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizeIsoDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function run(): Promise<void> {
  if (!TWITTERAPI_IO_KEY) fatal("TWITTERAPI_IO_KEY is required.");
  const usersPath = path.resolve(process.cwd(), "users.json");
  const usersRaw = await fs.readFile(usersPath, "utf-8");
  const parsed = JSON.parse(usersRaw);
  const sourceUsers: InputUser[] = Array.isArray(parsed) ? parsed : [];

  const uniq = new Map<string, {
    xUserId: string;
    handle: string;
    name: string | null;
    avatarUrl: string | null;
    followersCount: number | null;
    bio: string | null;
    accountCreatedAt: string | null;
  }>();
  for (const row of sourceUsers) {
    const xUserId = String(row?.x_user_id ?? "").trim();
    const handle = String(row?.handle ?? row?.username ?? "").trim().toLowerCase().replace(/^@+/, "");
    const name = String(row?.name ?? "").trim() || null;
    const avatarUrl = String(row?.avatar_url ?? "").trim() || null;
    const followersRaw = Number(row?.followers_count);
    const followersCount = Number.isFinite(followersRaw) && followersRaw >= 0 ? followersRaw : null;
    const bio = normalizeBio(row?.bio ?? row?.description ?? null);
    const accountCreatedAt = normalizeIsoDate(
      row?.accountCreatedAt ?? row?.account_created_at ?? row?.createdAt ?? row?.created_at ?? null
    );
    const key = xUserId ? `id:${xUserId}` : handle ? `h:${handle}` : "";
    if (!key || uniq.has(key)) continue;
    uniq.set(key, { xUserId, handle, name, avatarUrl, followersCount, bio, accountCreatedAt });
  }

  const users = [...uniq.values()];
  const total = users.length;
  let processed = 0;
  let matchedUsers = 0;
  let updated = 0;
  let bioFetchedFromProvider = 0;
  let accountCreatedFetchedFromProvider = 0;
  let bioRowsUpdated = 0;
  let accountCreatedRowsUpdated = 0;
  let insertedRows = 0;
  let baselineSeededRows = 0;
  let skippedUsers = 0;
  let failed = 0;
  const debugLimit = 10;

  const pool = new Pool({ connectionString: resolveConnectionString() });
  await ensureSchemaColumns(pool);
  console.log("[enrich:profiles] total users:", total);

  for (const user of users) {
    processed += 1;
    const debugEnabled = processed <= debugLimit;
    let attemptedMatchPath: "x_user_id" | "handle" | "none" = "none";
    let rowCount = 0;
    let skipReason = "";
    try {
      // Ensure every user from users.json has a DB row even if enrichment later fails.
      const baselineXUserId = user.xUserId || (user.handle ? `manual:${user.handle}` : "");
      if (baselineXUserId && user.handle) {
        const seeded = await pool.query(
          `
          INSERT INTO community_users (
            x_user_id,
            handle,
            name,
            avatar_url,
            followers_count,
            bio,
            account_created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, NOW())
          ON CONFLICT (x_user_id) DO UPDATE SET
            handle = COALESCE(NULLIF(EXCLUDED.handle, ''), community_users.handle),
            name = COALESCE(NULLIF(EXCLUDED.name, ''), community_users.name),
            avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), community_users.avatar_url),
            followers_count = COALESCE(NULLIF(EXCLUDED.followers_count, 0), community_users.followers_count),
            bio = COALESCE(NULLIF(community_users.bio, ''), EXCLUDED.bio),
            account_created_at = COALESCE(community_users.account_created_at, EXCLUDED.account_created_at),
            updated_at = NOW()
          `,
          [baselineXUserId, user.handle, user.name, user.avatarUrl, user.followersCount, user.bio, user.accountCreatedAt]
        );
        baselineSeededRows += Number(seeded.rowCount ?? 0);
      }

      const enrichment = await fetchProfileEnrichmentFromTwitterApiIo(
        { xUserId: user.xUserId, handle: user.handle },
        TWITTERAPI_IO_KEY
      );
      if (!enrichment) {
        skippedUsers += 1;
        skipReason = "enrichment_not_found_from_twitterapi";
        if (debugEnabled) {
          console.log("[enrich:profiles][debug]", {
            handle: user.handle || null,
            x_user_id: user.xUserId || null,
            hasBioFromProvider: false,
            hasAccountCreatedAtFromProvider: false,
            attemptedMatchPath,
            rowCount,
            skipReason,
          });
        }
      } else {
        const hasBioFromProvider = Boolean(enrichment.bio);
        const hasAccountCreatedAtFromProvider = Boolean(enrichment.accountCreatedAt);
        const bioFromUsersJson = normalizeBio(user.bio);
        const accountCreatedAtFromUsersJson = normalizeIsoDate(user.accountCreatedAt);
        const resolvedBio = normalizeBio(enrichment.bio ?? bioFromUsersJson);
        const resolvedAccountCreatedAt = normalizeIsoDate(
          enrichment.accountCreatedAt ?? accountCreatedAtFromUsersJson
        );
        if (hasBioFromProvider) bioFetchedFromProvider += 1;
        if (hasAccountCreatedAtFromProvider) accountCreatedFetchedFromProvider += 1;
        if (!resolvedBio && !resolvedAccountCreatedAt) {
          skippedUsers += 1;
          skipReason = "provider_returned_no_bio_and_no_account_created_at";
          if (debugEnabled) {
            console.log("[enrich:profiles][debug]", {
              handle: user.handle || null,
              x_user_id: user.xUserId || null,
              hasBioFromProvider,
              hasAccountCreatedAtFromProvider,
              attemptedMatchPath,
              rowCount,
              skipReason,
            });
          }
          continue;
        }

        let whereSql = "";
        let whereSqlUpdate = "";
        let whereParam: string | null = null;
        if (user.xUserId) {
          attemptedMatchPath = "x_user_id";
          whereParam = user.xUserId;
          whereSql = `x_user_id = $1`;
          whereSqlUpdate = `x_user_id = $3`;
        } else if (user.handle) {
          attemptedMatchPath = "handle";
          whereParam = user.handle;
          whereSql = `lower(coalesce(handle, '')) = $1`;
          whereSqlUpdate = `lower(coalesce(handle, '')) = $3`;
        } else {
          skippedUsers += 1;
          skipReason = "missing_x_user_id_and_handle";
          if (debugEnabled) {
            console.log("[enrich:profiles][debug]", {
              handle: user.handle || null,
              x_user_id: user.xUserId || null,
              hasBioFromProvider,
              hasAccountCreatedAtFromProvider,
              attemptedMatchPath,
              rowCount,
              skipReason,
            });
          }
          continue;
        }

        const existing = await pool.query(
          `
          SELECT bio, account_created_at
          FROM community_users
          WHERE ${whereSql}
          LIMIT 1
          `,
          [whereParam]
        );
        let currentRow = existing.rows[0] as { bio?: string | null; account_created_at?: string | null } | undefined;
        if (!currentRow) {
          const fallbackXUserId = user.xUserId || (user.handle ? `manual:${user.handle}` : "");
          if (!fallbackXUserId || !user.handle) {
            skippedUsers += 1;
            skipReason = attemptedMatchPath === "x_user_id" ? "no_db_match_for_x_user_id" : "no_db_match_for_handle";
            if (debugEnabled) {
              console.log("[enrich:profiles][debug]", {
                handle: user.handle || null,
                x_user_id: user.xUserId || null,
                hasBioFromProvider,
                hasAccountCreatedAtFromProvider,
                attemptedMatchPath,
                rowCount,
                skipReason,
              });
            }
            continue;
          }

          const inserted = await pool.query(
            `
            INSERT INTO community_users (
              x_user_id,
              handle,
              name,
              avatar_url,
              followers_count,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (x_user_id) DO UPDATE SET
              handle = COALESCE(NULLIF(EXCLUDED.handle, ''), community_users.handle),
              name = COALESCE(NULLIF(EXCLUDED.name, ''), community_users.name),
              avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), community_users.avatar_url),
              followers_count = COALESCE(NULLIF(EXCLUDED.followers_count, 0), community_users.followers_count),
              updated_at = NOW()
            `,
            [fallbackXUserId, user.handle, user.name, user.avatarUrl, user.followersCount]
          );
          insertedRows += Number(inserted.rowCount ?? 0);
          matchedUsers += 1;
          skipReason = "inserted_missing_db_row";
          currentRow = { bio: null, account_created_at: null };
          if (debugEnabled) {
            console.log("[enrich:profiles][debug]", {
              handle: user.handle || null,
              x_user_id: user.xUserId || null,
              hasBioFromProvider,
              hasAccountCreatedAtFromProvider,
              attemptedMatchPath,
              rowCount,
              skipReason,
            });
          }
        }
        if (existing.rows[0]) matchedUsers += 1;
        const existingBio = String(currentRow?.bio ?? "").trim();
        const existingAccountCreatedAt = currentRow?.account_created_at
          ? new Date(currentRow.account_created_at).toISOString()
          : null;
        const bioUpdated = Boolean(resolvedBio) && resolvedBio !== existingBio;
        const accountCreatedAtUpdated =
          Boolean(resolvedAccountCreatedAt) &&
          (!existingAccountCreatedAt || existingAccountCreatedAt !== resolvedAccountCreatedAt);

        const q = await pool.query(
          `
          UPDATE community_users
          SET
            bio = CASE WHEN $1::text IS NULL THEN bio ELSE $1::text END,
            account_created_at = CASE
              WHEN $2::timestamptz IS NULL THEN account_created_at
              ELSE COALESCE(account_created_at, $2::timestamptz)
            END,
            updated_at = NOW()
          WHERE ${whereSqlUpdate}
          `,
          [resolvedBio, resolvedAccountCreatedAt, whereParam]
        );
        const affected = Number(q.rowCount ?? 0);
        rowCount = affected;
        if (affected > 0) {
          updated += affected;
          if (bioUpdated) bioRowsUpdated += 1;
          if (accountCreatedAtUpdated) accountCreatedRowsUpdated += 1;
        }
        if (debugEnabled) {
          console.log("[enrich:profiles][debug]", {
            handle: user.handle || null,
            x_user_id: user.xUserId || null,
            hasBioFromProvider,
            hasAccountCreatedAtFromProvider,
            attemptedMatchPath,
            bioUpdated,
            accountCreatedAtUpdated,
            rowCount,
            skipReason: skipReason || null,
          });
        }
      }
    } catch (err) {
      failed += 1;
      skipReason = "exception_during_enrichment_or_update";
      if (debugEnabled) {
        console.log("[enrich:profiles][debug]", {
          handle: user.handle || null,
          x_user_id: user.xUserId || null,
          hasBioFromProvider: false,
          hasAccountCreatedAtFromProvider: false,
          attemptedMatchPath,
          rowCount,
          skipReason,
          error: String(err),
        });
      }
    }

    if (processed % 25 === 0 || processed === total) {
      console.log(`[enrich:profiles] processed=${processed}/${total} updated=${updated} failed=${failed}`);
    }
    await sleep(220);
  }

  await pool.end();
  console.log("[enrich:profiles] summary", {
    total_users_scanned: total,
    processed,
    matched_users: matchedUsers,
    inserted_rows: insertedRows,
    baseline_seeded_rows: baselineSeededRows,
    bio_fetched_from_provider: bioFetchedFromProvider,
    account_created_at_fetched_from_provider: accountCreatedFetchedFromProvider,
    rows_updated: updated,
    bio_rows_updated: bioRowsUpdated,
    account_created_at_rows_updated: accountCreatedRowsUpdated,
    skipped_users: skippedUsers,
    failed_users: failed,
  });
}

run().catch((err) => {
  console.error("[enrich:profiles] fatal:", err);
  process.exit(1);
});
