/**
 * One-time backfill: download and permanently store a local avatar for every
 * community user that does not already have a valid local avatar file.
 *
 * Reuses the same immutable, one-time `ensureLocalAvatar` logic as the login and
 * stance flows: users that already have a stored avatar are skipped and never
 * overwritten. Failures are logged and skipped; they never abort the run.
 *
 * Run:
 *   npm run backfill:avatars
 *
 * Important: run this where the server's avatars directory lives (e.g. on the
 * host / persistent disk). Point AVATAR_STORAGE_DIR at that directory if it is
 * not the default public/dist avatars folder.
 *
 * This is a standalone script and does NOT start the API server.
 */

import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  createEnsureLocalAvatar,
  createNodeAvatarDeps,
  resolveAvatarsDir,
} from "../avatarStorage.js";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });
dotenv.config();

function isAllowedAvatarHost(hostname: string): boolean {
  const host = String(hostname ?? "").toLowerCase();
  return host === "pbs.twimg.com" || host.endsWith(".twimg.com");
}

const CONCURRENCY = 4;

async function main(): Promise<void> {
  const connectionString = (process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    console.error("[backfill:avatars] DATABASE_URL is required");
    process.exit(1);
  }

  const isProd = (process.env.NODE_ENV || "") === "production";
  const distPath = path.resolve(process.cwd(), "dist");
  const avatarsDir = resolveAvatarsDir({
    envDir: process.env.AVATAR_STORAGE_DIR,
    isProd,
    distPath,
    cwd: process.cwd(),
  });

  const pool = new Pool({ connectionString });
  const deps = createNodeAvatarDeps({ pool, avatarsDir, isAllowedHost: isAllowedAvatarHost });
  const ensureLocalAvatar = createEnsureLocalAvatar(deps);

  console.log("[backfill:avatars] avatars dir:", avatarsDir);

  // Every user with a remote avatar source; ensureLocalAvatar decides per row
  // whether the local avatar already exists (skip) or must be downloaded.
  const { rows } = await pool.query(
    `
    SELECT x_user_id, avatar_path, avatar_url
    FROM community_users
    WHERE x_user_id IS NOT NULL
      AND coalesce(avatar_url, '') <> ''
    `
  );

  const total = rows.length;
  console.log(`[backfill:avatars] candidates: ${total}`);

  let processed = 0;
  let saved = 0;
  let alreadyPresent = 0;
  let failed = 0;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < rows.length) {
      const r = rows[cursor++] as {
        x_user_id: string;
        avatar_path: string | null;
        avatar_url: string | null;
      };
      const xUserId = String(r.x_user_id);
      processed++;

      const existingPath = String(r.avatar_path ?? "").trim();
      if (existingPath && deps.fileExists(existingPath)) {
        alreadyPresent++;
      } else {
        try {
          const result = await ensureLocalAvatar({
            x_user_id: xUserId,
            avatar_path: r.avatar_path,
            avatar_url: r.avatar_url,
          });
          if (result) saved++;
          else failed++;
        } catch {
          failed++;
        }
      }

      if (processed % 25 === 0 || processed === total) {
        console.log(
          `[backfill:avatars] progress processed=${processed}/${total} saved=${saved} already_present=${alreadyPresent} failed=${failed}`
        );
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, total || 1) }, () => worker());
  await Promise.all(workers);

  console.log(
    `[backfill:avatars] done processed=${processed} saved=${saved} already_present=${alreadyPresent} failed=${failed}`
  );

  await pool.end();
}

main().catch((err) => {
  console.error("[backfill:avatars] fatal error:", err);
  process.exit(1);
});
