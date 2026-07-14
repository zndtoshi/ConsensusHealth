import path from "node:path";
import dotenv from "dotenv";
import { createPool, redactConnectionString, resolveConnectionString } from "../db.js";
import { createDbAvatarProvisioner, ensureAvatarBlobsTable } from "../avatarProvisioning.js";
import { runAvatarBackfill, type AvatarBackfillCandidate } from "../avatarBackfill.js";

/**
 * One-time avatar backfill for existing community_users.
 *
 * Run with: `npm run backfill:avatars`
 *
 * Selects users that have a non-empty avatar_url but no avatar_blobs row yet,
 * then downloads and stores each avatar exactly once using the shared,
 * validated provisioning logic. Never overwrites an existing blob. Safe to
 * re-run: already-stored users are excluded by the query (and the provisioner
 * skips them anyway). This does NOT run on server startup.
 */

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });

async function main(): Promise<void> {
  const isProd = (process.env.NODE_ENV || "development") === "production";

  const connectionString = resolveConnectionString();
  console.log("[backfill:avatars] DB:", redactConnectionString(connectionString));
  const pool = createPool(connectionString);

  try {
    await ensureAvatarBlobsTable(pool);
    const { provisioner } = createDbAvatarProvisioner(pool, { isProd });

    const { rows } = await pool.query(
      `SELECT cu.x_user_id, cu.avatar_url
       FROM community_users cu
       WHERE cu.x_user_id IS NOT NULL
         AND cu.avatar_url IS NOT NULL
         AND btrim(cu.avatar_url) <> ''
         AND NOT EXISTS (SELECT 1 FROM avatar_blobs ab WHERE ab.x_user_id = cu.x_user_id)`
    );
    const candidates = rows as AvatarBackfillCandidate[];

    const stats = await runAvatarBackfill({
      candidates,
      ensure: (id, url) => provisioner.ensure(id, url),
      concurrency: Number(process.env.AVATAR_BACKFILL_CONCURRENCY),
    });

    console.log(
      `[backfill:avatars] summary total=${stats.total} stored=${stats.stored} skipped=${stats.skipped} failed=${stats.failed}`
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[backfill:avatars] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
