import path from "node:path";
import dotenv from "dotenv";
import { createPool, redactConnectionString, resolveConnectionString } from "../db.js";
import { createDbAvatarProvisioner, ensureAvatarBlobsTable } from "../avatarProvisioning.js";
import {
  fetchXProfileAvatarUrl,
  type ProfilePageResponse,
  type XProfileFetchResult,
} from "../xProfileScrape.js";
import { runAvatarRecovery, type AvatarRecoveryCandidate, type AvatarRecoveryOutcome } from "../avatarRecovery.js";
import { fetchProfileEnrichmentFromTwitterApiIo } from "../profileEnrichment.js";

/**
 * One-time avatar recovery for community users with no stored blob.
 *
 * Run with: `npm run recover:avatars`
 *
 * For each candidate it fetches the public https://x.com/<handle> page, extracts
 * the current avatar URL from Open Graph metadata, and stores it through the
 * existing validated, immutable provisioner (never overwriting an existing
 * blob). If TWITTERAPI_IO_KEY is configured, the X API is used as an optional
 * fallback when the public page yields nothing. Does NOT run on server startup.
 */

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_SCRAPE_RETRIES = 2;

const TWITTERAPI_IO_KEY = (process.env.TWITTERAPI_IO_KEY || "").trim();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchProfilePage(handle: string): Promise<ProfilePageResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://x.com/${encodeURIComponent(handle)}`, {
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    return { status: res.status, ok: res.ok, text: () => res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeWithRetries(handle: string): Promise<XProfileFetchResult> {
  let last: XProfileFetchResult = { ok: false, reason: "fetch_error" };
  for (let attempt = 0; attempt <= MAX_SCRAPE_RETRIES; attempt += 1) {
    last = await fetchXProfileAvatarUrl(handle, fetchProfilePage);
    if (last.ok) return last;
    const transient = last.reason === "rate_limited" || last.reason === "timeout" || last.reason === "fetch_error";
    if (!transient || attempt === MAX_SCRAPE_RETRIES) return last;
    const backoffMs = (last.reason === "rate_limited" ? 5000 : 1500) * (attempt + 1);
    await sleep(backoffMs);
  }
  return last;
}

async function main(): Promise<void> {
  const isProd = (process.env.NODE_ENV || "development") === "production";

  const connectionString = resolveConnectionString();
  console.log("[recover:avatars] DB:", redactConnectionString(connectionString));
  console.log("[recover:avatars] X API fallback:", TWITTERAPI_IO_KEY ? "enabled" : "disabled");
  const pool = createPool(connectionString);

  try {
    await ensureAvatarBlobsTable(pool);
    const { provisioner } = createDbAvatarProvisioner(pool, { isProd });

    const { rows } = await pool.query(
      `SELECT cu.x_user_id, cu.handle
       FROM community_users cu
       WHERE cu.x_user_id IS NOT NULL
         AND cu.handle IS NOT NULL
         AND btrim(cu.handle) <> ''
         AND NOT EXISTS (SELECT 1 FROM avatar_blobs ab WHERE ab.x_user_id = cu.x_user_id)`
    );
    const candidates = rows as AvatarRecoveryCandidate[];

    const recoverOne = async (candidate: AvatarRecoveryCandidate): Promise<AvatarRecoveryOutcome> => {
      const scraped = await scrapeWithRetries(candidate.handle);
      let url: string | null = scraped.ok ? scraped.url : null;
      let sourceReason = scraped.ok ? "public_page" : scraped.reason;

      // Optional X API fallback, only when configured and the page yielded nothing.
      if (!url && TWITTERAPI_IO_KEY) {
        try {
          const enrichment = await fetchProfileEnrichmentFromTwitterApiIo(
            { xUserId: candidate.x_user_id, handle: candidate.handle },
            TWITTERAPI_IO_KEY
          );
          if (enrichment?.avatarUrl) {
            url = enrichment.avatarUrl;
            sourceReason = "twitterapi_io";
          }
        } catch {
          // Fallback failure is non-fatal; fall through to failed below.
        }
      }

      if (!url) return { status: "failed", reason: sourceReason };

      const result = await provisioner.ensure(candidate.x_user_id, url);
      switch (result.status) {
        case "stored":
          return { status: "stored" };
        case "exists":
          return { status: "exists" };
        case "skipped_no_url":
          return { status: "skipped", reason: "no_url" };
        case "failed":
          return { status: "failed", reason: result.reason };
      }
    };

    const stats = await runAvatarRecovery({
      candidates,
      recoverOne,
      concurrency: Number(process.env.AVATAR_RECOVERY_CONCURRENCY),
      perItemDelayMs: Number(process.env.AVATAR_RECOVERY_DELAY_MS ?? 800),
    });

    console.log(
      `[recover:avatars] summary total=${stats.total} stored=${stats.stored} exists=${stats.exists} ` +
        `skipped=${stats.skipped} failed=${stats.failed}`
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[recover:avatars] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
