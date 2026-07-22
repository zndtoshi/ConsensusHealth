/**
 * Recover blank avatars by refreshing profile images via twitterapi.io.
 *
 * Targets community_users with no valid local avatar_path (NULL/missing file),
 * including the ~24 remote-only stale pbs.twimg.com cases.
 *
 *   npm run recover:avatars
 *
 * Env:
 *   DATABASE_URL
 *   TWITTERAPI_API_KEY
 *   AVATAR_STORAGE_DIR (optional)
 *   AVATAR_RECOVER_CONCURRENCY (default 2)
 *   AVATAR_RECOVER_DELAY_MS (default 400)
 */

import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import {
  avatarRecoveryPublicPath,
  emptyAvatarRecoveryStats,
  formatAvatarRecoverySummary,
  needsAvatarRecovery,
  recoverOneAvatar,
  type AvatarRecoveryCandidate,
} from "../avatarRecovery.js";
import {
  avatarExtForContentType,
  createNodeAvatarDeps,
  MAX_AVATAR_BYTES,
  resolveAvatarsDir,
} from "../avatarStorage.js";
import {
  fetchProfileEnrichmentFromTwitterApiIo,
  resolveTwitterApiKey,
} from "../profileEnrichment.js";
import { isDigitOnlyXUserId, normalizeHandle } from "../xUserId.js";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });
dotenv.config();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAllowedAvatarHost(hostname: string): boolean {
  const host = String(hostname ?? "").toLowerCase();
  return host === "pbs.twimg.com" || host.endsWith(".twimg.com");
}

async function main(): Promise<void> {
  const connectionString = (process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    console.error("[recover:avatars] DATABASE_URL is required");
    process.exit(1);
  }
  const apiKey = resolveTwitterApiKey();
  if (!apiKey) {
    console.error("[recover:avatars] TWITTERAPI_API_KEY is required");
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

  const concurrency = Math.max(
    1,
    Math.min(6, Number(process.env.AVATAR_RECOVER_CONCURRENCY || 2) || 2)
  );
  const delayMs = Math.max(0, Number(process.env.AVATAR_RECOVER_DELAY_MS || 400) || 400);

  const pool = new Pool({ connectionString });
  const nodeDeps = createNodeAvatarDeps({
    pool,
    avatarsDir,
    isAllowedHost: isAllowedAvatarHost,
  });

  console.log("[recover:avatars] avatars dir:", avatarsDir);

  const { rows } = await pool.query(
    `
    SELECT x_user_id, handle, avatar_path, avatar_url
    FROM community_users
    WHERE x_user_id IS NOT NULL
      AND coalesce(handle, '') <> ''
    `
  );

  const all = rows.map((r) => ({
    x_user_id: String(r.x_user_id ?? "").trim(),
    handle: normalizeHandle(r.handle),
    avatar_path: r.avatar_path != null ? String(r.avatar_path) : null,
    avatar_url: r.avatar_url != null ? String(r.avatar_url) : null,
  })) as AvatarRecoveryCandidate[];

  const candidates = all.filter((row) => needsAvatarRecovery(row, nodeDeps.fileExists));
  console.log(
    `[recover:avatars] scanned=${all.length} needing_recovery=${candidates.length} concurrency=${concurrency}`
  );

  const stats = emptyAvatarRecoveryStats();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const row = candidates[idx]!;
      try {
        const outcome = await recoverOneAvatar(row, {
          fileExists: nodeDeps.fileExists,
          maxBytes: MAX_AVATAR_BYTES,
          async fetchProfile({ xUserId, handle }) {
            const preferId = xUserId && isDigitOnlyXUserId(xUserId) ? xUserId : null;
            const enrichment = await fetchProfileEnrichmentFromTwitterApiIo(
              { xUserId: preferId, handle },
              apiKey,
              {
                onRateLimited: ({ waitMs }) => {
                  console.warn("[recover:avatars] rate-limited", { waitMs, handle });
                },
              }
            );
            if (!enrichment) return null;
            return {
              id: enrichment.id,
              username: enrichment.username,
              profileImageUrl: enrichment.profileImageUrl,
              unavailable: enrichment.unavailable,
              unavailableReason: enrichment.unavailableReason,
            };
          },
          fetchImage: nodeDeps.fetchImage,
          writeAtomic: nodeDeps.writeAtomic,
          async updateAvatar({ xUserId, avatarPath, avatarUrl }) {
            await pool.query(
              `
              UPDATE community_users
              SET
                avatar_path = $2,
                avatar_url = $3,
                updated_at = NOW()
              WHERE x_user_id = $1
              `,
              [xUserId, avatarPath, avatarUrl]
            );
          },
        });

        if (outcome.kind === "recovered") {
          stats.recovered += 1;
          console.log("[recover:avatars] recovered", {
            handle: row.handle,
            x_user_id: row.x_user_id,
            avatar_path: outcome.avatarPath,
            avatar_url: outcome.avatarUrl,
          });
        } else if (outcome.kind === "skipped") {
          stats.skipped += 1;
          console.log("[recover:avatars] skipped", {
            handle: row.handle,
            reason: outcome.reason,
          });
        } else if (outcome.kind === "unavailable") {
          stats.unavailable += 1;
          console.warn("[recover:avatars] unavailable", {
            handle: row.handle,
            x_user_id: row.x_user_id,
            reason: outcome.reason,
          });
        } else {
          stats.failed += 1;
          console.warn("[recover:avatars] failed", {
            handle: row.handle,
            x_user_id: row.x_user_id,
            reason: outcome.reason,
          });
        }
      } catch (e) {
        stats.failed += 1;
        console.warn("[recover:avatars] failed", {
          handle: row.handle,
          err: String(e),
        });
      }

      if (delayMs > 0) await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length || 1) }, () => worker()));

  // Count rows that already had valid locals as skipped for the summary context.
  const alreadyOk = all.length - candidates.length;
  stats.skipped += alreadyOk;

  console.log("");
  console.log(formatAvatarRecoverySummary(stats));
  console.log("");
  console.log("[recover:avatars] done", {
    alreadyHadLocalAvatar: alreadyOk,
    recoveryCandidates: candidates.length,
    examplePath: avatarRecoveryPublicPath("example") || "/avatars/{handle}.jpg",
    contentTypes: ["image/jpeg", "image/png", "image/webp"].map(avatarExtForContentType),
  });

  await pool.end();
}

main().catch((err) => {
  console.error("[recover:avatars] fatal", err);
  process.exit(1);
});
