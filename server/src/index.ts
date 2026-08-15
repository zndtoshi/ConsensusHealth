import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { Pool, type PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import { logConfig } from "./config/appUrl.js";
import {
  fetchProfileEnrichmentFromTwitterApiIo,
  resolveTwitterApiKey,
} from "./profileEnrichment.js";
import {
  decodeStanceHistoryCursor,
  isPrivilegedManualEditorHandle,
  normalizeStanceValue,
  type ChangedByValue,
  type StanceValue,
} from "./stanceHistory.js";
import {
  DEFAULT_PROPOSAL_ID,
  ensureProposalSchema,
  getProposalById,
  isFinalProposalStatus,
  listEnabledProposals,
  loadAccessibleProposals,
  resolveProposalAccessAsync,
  type ProposalId,
} from "./proposals.js";
import { buildStanceCsvExport } from "./stanceCsvExport.js";
import {
  createEnsureLocalAvatar,
  createNodeAvatarDeps,
  resolveAvatarsDir,
} from "./avatarStorage.js";
import { clampNewStancesLimit, queryNewStanceEvents } from "./newStances.js";
import { runStatsQueries } from "./proposalStats.js";
import { coerceXUserIdToDigitString } from "./xUserId.js";
import {
  normalizeRemovedHandle,
  normalizeRemovedXUserId,
  resolveRemovalTarget,
} from "./removedCommunityUsers.js";
import {
  confirmExplanationForStance,
  deleteStanceExplanation,
  loadExplanationsForUser,
  verifyAndUpsertStanceExplanation,
} from "./stanceExplanations.js";
import { createStanceExplanationHandlers } from "./stanceExplanationHandlers.js";
import { createAdminStanceHandler } from "./adminStanceHandlers.js";
import { assertProductionEnv } from "./security/envValidation.js";
import {
  assertNoTestSwitchesInProduction,
  resolveE2eServeDist,
  resolveForceListen,
  resolveHelmetProd,
  resolveXOauthMock,
} from "./security/testMode.js";
import { buildCorsOriginAllowlist, createCorsOptions } from "./security/corsOrigins.js";
import {
  createHelmetMiddleware,
  createPermissionsPolicyMiddleware,
} from "./security/httpSecurity.js";
import {
  createAccountDeletionRateLimiters,
  createAdminWriteRateLimiters,
  createAuthRateLimiter,
  createAvatarProxyRateLimiter,
  createGeneralApiRateLimiter,
  createStanceExplanationWriteRateLimiters,
  createStanceWriteRateLimiters,
  createStatsReadRateLimiter,
} from "./security/rateLimits.js";
import {
  cleanupExpiredOAuthStates,
  consumeOAuthState,
  ensureOAuthStateTable,
  saveOAuthState,
} from "./oauthStateStore.js";
import { reconcileOauthCommunityUser } from "./oauthAccountReconcile.js";
import { renderAuthPopupPage } from "./oauthPopupPage.js";
export { renderAuthPopupPage } from "./oauthPopupPage.js";
import { createAccountDeletionHandler } from "./accountDeletion.js";
import { ensurePrivacySuppressionsTable } from "./privacySuppressions.js";
import { createHealthRouter } from "./healthRoutes.js";
import { queryConsensusOverview } from "./consensusOverview.js";
import {
  approveNameTheForkCandidate,
  buildNameTheForkPayload,
  castNameTheForkVote,
  ensureNameTheForkSchema,
  hideNameTheForkCandidate,
  rejectNameTheForkCandidate,
  removeNameTheForkVote,
  submitCustomNameTheForkCandidate,
} from "./nameTheFork.js";
import {
  loadMergedCommunityUsersWithStance as loadMergedCommunityUsersWithStanceShared,
  loadSeededAccountsForCommunity as loadSeededAccountsForCommunityShared,
  mapStanceHistoryPublicRow,
  queryRecentStanceHistoryPage as queryRecentStanceHistoryPageShared,
} from "./communityPublicSurfaces.js";
import {
  createRequestIdMiddleware,
  createRequestLoggingMiddleware,
  logOAuthProviderFailure,
} from "./requestLogging.js";
import { gracefulShutdown } from "./gracefulShutdown.js";
import { initErrorMonitoring, type ErrorMonitoringHandle } from "./errorMonitoring.js";
import {
  assertClientIpConfig,
  clientIpRateLimitKey,
  createOriginLockMiddleware,
  type ClientIpConfig,
} from "./security/clientIp.js";
import { getContactEmail } from "./security/envValidation.js";
import {
  E2E_OAUTH_FAIL_COOKIE,
  E2E_USER_COOKIE,
  isConsensusHealthE2E,
  parseE2EOauthFailMode,
  parseE2EUserKey,
  resolveE2EMockIdentity,
} from "./e2eMockIdentity.js";
import { fileURLToPath } from "node:url";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });

const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const E2E_SERVE_DIST = resolveE2eServeDist(process.env);
const X_OAUTH_MOCK = resolveXOauthMock(process.env);
const FORCE_LISTEN = resolveForceListen(process.env);
const HELMET_IS_PROD = resolveHelmetProd(process.env);
/** Per-login e2e_user + related hooks — only when strict test mode already enabled mock OAuth. */
const CONSENSUSHEALTH_E2E = X_OAUTH_MOCK && isConsensusHealthE2E(process.env);

assertProductionEnv(process.env);
assertNoTestSwitchesInProduction(process.env);
const clientIpConfig: ClientIpConfig = assertClientIpConfig(process.env, { isProd: IS_PROD });

const APP_ORIGIN_ENV = (process.env.APP_ORIGIN || "").trim();
const APP_URL_ENV = (process.env.APP_URL || "").trim();
const DIST_PATH = path.resolve(process.cwd(), "dist");
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const TWITTER_CLIENT_ID = process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID || "";
const TWITTER_CLIENT_SECRET = process.env.X_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET || "";
// Used as a fallback when X /users/me omits bio or created_at (also available in prod).
const PROFILE_ENRICHMENT_KEY = resolveTwitterApiKey();
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
/** Operator-declared backup retention policy (days); exposed via public-config / Privacy. */
const BACKUP_RETENTION_DAYS_RAW = Number(process.env.BACKUP_RETENTION_DAYS || 7);
const BACKUP_RETENTION_DAYS =
  Number.isFinite(BACKUP_RETENTION_DAYS_RAW) && BACKUP_RETENTION_DAYS_RAW > 0
    ? Math.floor(BACKUP_RETENTION_DAYS_RAW)
    : 7;
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const STATS_CACHE_TTL_MS = 45_000;
// BIP-110 has concluded. Keep identity/session infrastructure active for future BIPs,
// while making this proposal's final positions immutable at the API boundary.
const SELF_STANCE_UPDATES_ENABLED: boolean = true;
const statsResponseCacheByProposal = new Map<
  string,
  { expiresAt: number; payload: Record<string, unknown> }
>();

function invalidateStatsCache(): void {
  statsResponseCacheByProposal.clear();
}

if (!SESSION_SECRET) {
  console.warn("SESSION_SECRET missing; signed cookies will not work");
}

function fatalEnv(msg: string): never {
  console.error(`\n[ConsensusHealth server] ${msg}\n`);
  console.error("Create: server/.env (NOT committed) with e.g.\n");
  console.error("DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/consensushealth");
  console.error("APP_ORIGIN=http://localhost:5173");
  console.error("SESSION_SECRET=change_me_long_random\n");
  process.exit(1);
}

let connectionString = DATABASE_URL;
if (!connectionString) {
  const PGHOST = (process.env.PGHOST || "localhost").trim();
  const PGPORT = (process.env.PGPORT || "5432").trim();
  const PGDATABASE = (process.env.PGDATABASE || "consensushealth").trim();
  const PGUSER = (process.env.PGUSER || "postgres").trim();
  const PGPASSWORD = (process.env.PGPASSWORD || "").trim();

  if (!PGPASSWORD) {
    fatalEnv("DATABASE_URL is missing, and PGPASSWORD is missing. Postgres SCRAM requires a password.");
  }

  const encodedUser = encodeURIComponent(PGUSER);
  const encodedPass = encodeURIComponent(PGPASSWORD);
  const built = `postgresql://${encodedUser}:${encodedPass}@${PGHOST}:${PGPORT}/${PGDATABASE}`;

  console.warn(
    "[ConsensusHealth server] DATABASE_URL not set. Using PG* vars to connect:",
    `postgresql://${PGUSER}:***@${PGHOST}:${PGPORT}/${PGDATABASE}`
  );

  connectionString = built;
}

try {
  const u = new URL(connectionString);
  if (!u.password) {
    fatalEnv("DATABASE_URL does not include a password. Use postgresql://user:PASSWORD@host:port/db");
  }
} catch {
  fatalEnv("DATABASE_URL is not a valid URL.");
}

const pool = new Pool({ connectionString });
console.log("[ConsensusHealth server] DB:", connectionString.replace(/:(?:[^@]*)@/, ":***@"));

// Directory where downloaded avatars are stored and served from. Configurable
// via AVATAR_STORAGE_DIR (e.g. a mounted persistent disk on the host).
const AVATARS_DIR = resolveAvatarsDir({
  envDir: process.env.AVATAR_STORAGE_DIR,
  isProd: IS_PROD,
  distPath: DIST_PATH,
  cwd: process.cwd(),
});
// One-time permanent avatar provisioner (used by login/stance hooks + backfill).
const ensureLocalAvatar = createEnsureLocalAvatar(
  createNodeAvatarDeps({ pool, avatarsDir: AVATARS_DIR, isAllowedHost: isAllowedAvatarHost })
);

const allowedOrigins = buildCorsOriginAllowlist(process.env, { isProd: IS_PROD });

const app = express();
app.set("trust proxy", clientIpConfig.trustProxyHops);
app.disable("x-powered-by");
app.use(
  createHelmetMiddleware({
    isProd: HELMET_IS_PROD,
    // HTTP E2E keeps prod CSP without HSTS / upgrade-insecure-requests.
    enforceHttpsRedirects: IS_PROD,
  })
);
app.use(createPermissionsPolicyMiddleware());
app.use(createOriginLockMiddleware(clientIpConfig));
app.use(cors(createCorsOptions({ env: process.env, isProd: IS_PROD, allowlist: allowedOrigins })));
app.use(createRequestIdMiddleware());
app.use(createRequestLoggingMiddleware());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(SESSION_SECRET));

const rateLimitUserId = (req: Request): string | null => getSessionUser(req)?.x_user_id ?? null;
const rateLimitClientIp = (req: Request) => clientIpRateLimitKey(req, clientIpConfig);
app.use("/api", createGeneralApiRateLimiter({ getClientIpKey: rateLimitClientIp }));
app.use("/auth", createAuthRateLimiter({ getClientIpKey: rateLimitClientIp }));
app.use(
  "/api/admin",
  ...createAdminWriteRateLimiters({ getXUserId: rateLimitUserId, getClientIpKey: rateLimitClientIp })
);

// CSP-safe OAuth popup helper (also copied into dist/public by Vite).
const PUBLIC_PATH = path.resolve(process.cwd(), "public");
app.get("/auth/popup-complete.js", (_req, res) => {
  const fromPublic = path.join(PUBLIC_PATH, "auth", "popup-complete.js");
  const fromDist = path.join(DIST_PATH, "auth", "popup-complete.js");
  const file = fs.existsSync(fromPublic) ? fromPublic : fromDist;
  res.type("application/javascript");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(file);
});

/**
 * Terminate the OAuth callback: for popup logins return the self-closing page;
 * otherwise preserve the original redirect (success) / JSON error behavior.
 */
function finishAuthResult(req: Request, res: Response, ok: boolean, isPopup: boolean): void {
  if (isPopup) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).type("html").send(renderAuthPopupPage(ok ? "success" : "error", computeFrontendBase(req)));
    return;
  }
  if (ok) {
    res.redirect(frontendRedirect(req, "/"));
    return;
  }
  res.status(500).json({ error: "oauth_failed" });
}

type SessionUser = {
  x_user_id: string;
  handle: string;
  name: string | null;
  avatar_url: string | null;
  followers_count: number | null;
  stance: string | null;
  equal_avatar_size: boolean;
};

function isAllowedAvatarHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "pbs.twimg.com" || host.endsWith(".twimg.com");
}

function normalizeHandle(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^@+/, "");
}

/**
 * Canonical stance writer.
 * - Always updates user_proposal_stances (+ history on change).
 * - For BIP110 only, mirrors into legacy community_users.stance / stance_history /
 *   stance_events in the SAME transaction (compatibility; not authoritative).
 */
async function upsertStanceWithHistory(
  client: PoolClient,
  args: {
    xUserId: string;
    handle: string;
    name: string | null;
    avatarUrl: string | null;
    followersCount: number | null;
    stance: StanceValue;
    changedBy: ChangedByValue;
    proposalId?: ProposalId;
  }
): Promise<{ row: Record<string, unknown>; changed: boolean; previous: StanceValue | null }> {
  const xUserId = String(args.xUserId || "").trim();
  const handle = normalizeHandle(args.handle);
  if (!xUserId || !handle) {
    throw new Error("x_user_id and handle are required");
  }
  const proposalId: ProposalId = args.proposalId || DEFAULT_PROPOSAL_ID;
  const incomingFollowersNum = Number(args.followersCount);
  const safeIncomingFollowers =
    Number.isFinite(incomingFollowersNum) && incomingFollowersNum > 0 ? incomingFollowersNum : null;
  const incomingAvatar = String(args.avatarUrl ?? "").trim() || null;
  const incomingName = String(args.name ?? "").trim() || null;
  const nextStance = args.stance;

  // Ensure community_users row exists (identity / avatar) without necessarily changing BIP110 stance.
  const prevUserRes = await client.query(
    "SELECT stance, followers_count FROM community_users WHERE x_user_id = $1 LIMIT 1",
    [xUserId]
  );
  const prevUserRow = prevUserRes.rows[0] as
    | { stance?: string | null; followers_count?: number | null }
    | undefined;
  const followersBefore = Number(prevUserRow?.followers_count ?? NaN);

  const prevPropRes = await client.query(
    `SELECT stance FROM user_proposal_stances WHERE x_user_id = $1 AND proposal_id = $2 LIMIT 1`,
    [xUserId, proposalId]
  );
  const prevStance = normalizeStanceValue(prevPropRes.rows[0]?.stance ?? null);
  const changed = prevStance !== nextStance;

  // Identity row first — do not treat community_users.stance as authoritative.
  // Preserve existing legacy stance on conflict; BIP110 mirror updates it after canonical write.
  const result = await client.query(
    `
    INSERT INTO community_users (
      x_user_id,
      handle,
      name,
      avatar_url,
      followers_count,
      stance,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (x_user_id)
    DO UPDATE SET
      handle = COALESCE(NULLIF(EXCLUDED.handle, ''), community_users.handle),
      name = COALESCE(NULLIF(EXCLUDED.name, ''), community_users.name),
      avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), community_users.avatar_url),
      followers_count = COALESCE(NULLIF(EXCLUDED.followers_count, 0), community_users.followers_count),
      updated_at = NOW()
    RETURNING *
  `,
    [
      xUserId,
      handle,
      incomingName,
      incomingAvatar,
      safeIncomingFollowers,
      prevUserRow?.stance ?? null,
    ]
  );
  let row = (result.rows[0] ?? {}) as Record<string, unknown>;

  // Canonical source of truth (all proposals, including BIP110).
  await client.query(
    `
    INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (x_user_id, proposal_id)
    DO UPDATE SET stance = EXCLUDED.stance, updated_at = NOW()
    `,
    [xUserId, proposalId, nextStance]
  );

  if (changed) {
    await client.query(
      `
      INSERT INTO user_proposal_stance_history (x_user_id, proposal_id, previous_stance, new_stance, changed_by)
      VALUES ($1, $2, $3, $4, $5)
    `,
      [xUserId, proposalId, prevStance, nextStance, args.changedBy]
    );
  }

  // BIP110 compatibility mirrors only — same transaction; failure rolls everything back.
  if (proposalId === DEFAULT_PROPOSAL_ID) {
    const mirrored = await client.query(
      `
      UPDATE community_users
      SET stance = $2, updated_at = NOW()
      WHERE x_user_id = $1
      RETURNING *
      `,
      [xUserId, nextStance]
    );
    row = (mirrored.rows[0] ?? row) as Record<string, unknown>;
    if (changed) {
      await client.query(
        `
        INSERT INTO stance_history (x_user_id, previous_stance, new_stance, changed_by)
        VALUES ($1, $2, $3, $4)
      `,
        [xUserId, prevStance, nextStance, args.changedBy]
      );
      await client.query(
        `
        INSERT INTO stance_events (x_user_id, from_stance, to_stance)
        VALUES ($1, $2, $3)
      `,
        [xUserId, prevStance, nextStance]
      );
    }
  }

  if (changed) {
    invalidateStatsCache();
  }

  if (process.env.NODE_ENV !== "production") {
    console.log("[stance-update]", {
      x_user_id: xUserId,
      handle,
      proposal_id: proposalId,
      previous_stance: prevStance,
      next_stance: nextStance,
      changed,
      followers_before: Number.isFinite(followersBefore) ? followersBefore : null,
      followers_after: row.followers_count ?? null,
      patch_mode: true,
    });
  }

  return {
    row: { ...row, stance: nextStance, proposal_id: proposalId },
    changed,
    previous: prevStance,
  };
}

function b64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeVerifier(): string {
  return b64url(crypto.randomBytes(48));
}

function createCodeChallenge(verifier: string): string {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

function getBearerTokenBasicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function cookieSecure(req: Request): boolean {
  if (!IS_PROD) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return req.secure || proto.includes("https");
}

function computeFrontendBase(req: Request): string {
  if (APP_ORIGIN_ENV) return APP_ORIGIN_ENV;
  if (APP_URL_ENV) return APP_URL_ENV;
  const protoHeader = String(req.header("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = protoHeader || req.protocol || "http";
  const hostHeader = String(req.header("x-forwarded-host") || "").split(",")[0].trim();
  const host = hostHeader || req.get("host") || "";
  if (host) return `${proto}://${host}`.replace(/\/+$/, "");
  return "http://localhost:5173";
}

function frontendRedirect(req: Request, targetPath = "/"): string {
  const base = computeFrontendBase(req);
  try {
    const url = new URL(base);
    url.pathname = targetPath;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    if (base.startsWith("http://") || base.startsWith("https://")) {
      return `${base.replace(/\/$/, "")}${targetPath.startsWith("/") ? targetPath : `/${targetPath}`}`;
    }
    return targetPath;
  }
}

function computeOAuthBase(req: Request): string {
  const appUrl = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (appUrl) return appUrl;

  const proto = String(req.header("x-forwarded-proto") || "http").split(",")[0].trim();
  const host = String(req.header("x-forwarded-host") || req.header("host") || "").split(",")[0].trim();
  const baseFromReq = `${proto}://${host}`.replace(/\/+$/, "");
  return baseFromReq;
}

function computeOAuthRedirectUri(req: Request): string {
  return `${computeOAuthBase(req)}/auth/x/callback`;
}

async function loadMergedCommunityUsersWithStance(
  proposalId: ProposalId = DEFAULT_PROPOSAL_ID
): Promise<Record<string, unknown>[]> {
  return loadMergedCommunityUsersWithStanceShared(pool, proposalId, {
    loadSeededAccounts: () =>
      loadSeededAccountsForCommunityShared([
        path.resolve(process.cwd(), "public", "data", "accounts_stanced.json"),
        path.resolve(DIST_PATH, "data", "accounts_stanced.json"),
      ]),
  });
}

async function queryRecentStanceHistoryPage(args: {
  limit: number;
  cursor?: { changed_at: string; id: number } | null;
  proposalId?: ProposalId;
}) {
  return queryRecentStanceHistoryPageShared(pool, args);
}

async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      id SERIAL PRIMARY KEY,
      x_user_id TEXT UNIQUE,
      handle TEXT,
      name TEXT,
      avatar_url TEXT,
      followers_count INTEGER,
      stance TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Keep handles normalized to lowercase to avoid duplicate identities by case.
  await pool.query(`UPDATE community_users SET handle = lower(handle) WHERE handle IS NOT NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_community_users_handle_lower ON community_users ((lower(handle)));`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      x_user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      followers_count INTEGER,
      stance TEXT CHECK (stance IN ('against','neutral','approve')),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      x_user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS bio TEXT;`);
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS equal_avatar_size BOOLEAN DEFAULT FALSE;`);
  // Permanent local avatar file path (e.g. "/avatars/<x_user_id>.jpg"). Immutable
  // once set: see ensureLocalAvatar in avatarStorage.ts.
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS avatar_path TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stance_events (
      id SERIAL PRIMARY KEY,
      x_user_id TEXT NOT NULL,
      from_stance TEXT,
      to_stance TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stance_events_x_user_id ON stance_events (x_user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stance_events_created_at ON stance_events (created_at);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stance_history (
      id SERIAL PRIMARY KEY,
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      previous_stance TEXT CHECK (previous_stance IN ('against','neutral','approve') OR previous_stance IS NULL),
      new_stance TEXT NOT NULL CHECK (new_stance IN ('against','neutral','approve')),
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      changed_by TEXT NULL CHECK (changed_by IN ('user','admin','system','oauth','backfill') OR changed_by IS NULL)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stance_history_x_user_id ON stance_history (x_user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stance_history_changed_at ON stance_history (changed_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stance_history_x_user_id_changed_at ON stance_history (x_user_id, changed_at);`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_stance_history_changed_at_id_desc ON stance_history (changed_at DESC, id DESC);`
  );
  // Supports latest-event-per-user selection (ROW_NUMBER PARTITION BY x_user_id ORDER BY changed_at DESC, id DESC).
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_stance_history_user_changed_at_id_desc ON stance_history (x_user_id, changed_at DESC, id DESC);`
  );
  // Supports the correlated EXISTS (per community_users row) in /api/community and the
  // playback CTE: WHERE sh.x_user_id = $ AND sh.changed_by = 'user'.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_stance_history_x_user_id_changed_by ON stance_history (x_user_id, changed_by);`
  );
  // Admin removals: hide seeded + DB users from the public graph until restored.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS removed_community_users (
      id SERIAL PRIMARY KEY,
      handle TEXT,
      x_user_id TEXT,
      removed_by TEXT NOT NULL,
      removed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT removed_community_users_target_chk CHECK (
        (handle IS NOT NULL AND length(trim(handle)) > 0)
        OR (x_user_id IS NOT NULL AND length(trim(x_user_id)) > 0)
      )
    );
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_removed_community_users_handle
     ON removed_community_users (lower(handle))
     WHERE handle IS NOT NULL AND length(trim(handle)) > 0;`
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_removed_community_users_x_user_id
     ON removed_community_users (x_user_id)
     WHERE x_user_id IS NOT NULL AND length(trim(x_user_id)) > 0;`
  );
  // Idempotent backfill: seed one initial history event for rows that already have stance and no history.
  await pool.query(`
    INSERT INTO stance_history (x_user_id, previous_stance, new_stance, changed_at, changed_by)
    SELECT
      cu.x_user_id,
      NULL,
      CASE
        WHEN lower(coalesce(cu.stance, '')) = 'support' THEN 'approve'
        WHEN lower(coalesce(cu.stance, '')) IN ('against', 'neutral', 'approve') THEN lower(cu.stance)
        ELSE NULL
      END AS stance_norm,
      COALESCE(cu.updated_at::timestamptz, cu.created_at::timestamptz, now()) AS changed_at,
      'backfill'
    FROM community_users cu
    WHERE cu.x_user_id IS NOT NULL
      AND (
        CASE
          WHEN lower(coalesce(cu.stance, '')) = 'support' THEN 'approve'
          WHEN lower(coalesce(cu.stance, '')) IN ('against', 'neutral', 'approve') THEN lower(cu.stance)
          ELSE NULL
        END
      ) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM stance_history sh WHERE sh.x_user_id = cu.x_user_id);
  `);

  // Multi-BIP proposal tables + BIP110 backfill (idempotent).
  await ensureProposalSchema(pool);
  await ensureNameTheForkSchema(pool);
  await ensureOAuthStateTable(pool);
  await ensurePrivacySuppressionsTable(pool);
}

async function cleanupExpiredSessions(): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await cleanupExpiredOAuthStates(pool);
}

function getSessionUser(req: Request): SessionUser | null {
  const raw = req.signedCookies?.consensushealth_session as unknown;
  if (!raw) return null;
  const obj = typeof raw === "string" ? (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })() : raw;
  if (!obj || typeof obj !== "object") return null;
  const x_user_id = String((obj as Record<string, unknown>).x_user_id || "").trim();
  const handle = String((obj as Record<string, unknown>).handle || "").trim().toLowerCase();
  if (!x_user_id || !handle) return null;
  const name = (obj as Record<string, unknown>).name;
  const avatar_url = (obj as Record<string, unknown>).avatar_url;
  const followers_count = (obj as Record<string, unknown>).followers_count;
  return {
    x_user_id,
    handle,
    name: typeof name === "string" ? name : null,
    avatar_url: typeof avatar_url === "string" ? avatar_url : null,
    followers_count:
      typeof followers_count === "number"
        ? followers_count
        : Number(followers_count || 0) || null,
    stance: null,
    equal_avatar_size: false,
  };
}

type DevCookieUser = {
  x_user_id: string;
  handle: string;
  name?: string | null;
  avatar_url?: string | null;
  followers_count?: number | null;
};

function getDevCookieUser(req: Request): DevCookieUser | null {
  const raw = req.signedCookies?.consensushealth_dev_user as DevCookieUser | undefined;
  if (!raw) return null;
  const x_user_id = String(raw.x_user_id || "").trim();
  const handle = String(raw.handle || "").trim().toLowerCase();
  if (!x_user_id || !handle) return null;
  return {
    x_user_id,
    handle,
    name: raw.name ?? null,
    avatar_url: raw.avatar_url ?? null,
    followers_count:
      typeof raw.followers_count === "number"
        ? raw.followers_count
        : Number(raw.followers_count || 0) || 0,
  };
}

async function startXAuth(req: Request, res: Response): Promise<void> {
  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    res.status(500).json({ error: "Twitter OAuth env vars are missing" });
    return;
  }
  const state = uuidv4();
  const browser_nonce = uuidv4();
  const code_verifier = createCodeVerifier();
  const challenge = createCodeChallenge(code_verifier);
  const isPopup = String(req.query.mode || "") === "popup";
  const e2eFailMode = CONSENSUSHEALTH_E2E ? parseE2EOauthFailMode(req.query.e2e_fail) : null;
  await saveOAuthState(pool, {
    state,
    code_verifier,
    mode: isPopup ? "popup" : "redirect",
    browser_nonce,
    // Expired-before-callback path for deterministic E2E (strict test mode only).
    ...(e2eFailMode === "expired" ? { ttlMs: -1, now: new Date() } : {}),
  });
  // Browser binding cookie (value = browser_nonce; verified on callback).
  res.cookie("consensushealth_oauth_state", browser_nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    path: "/",
    maxAge: 10 * 60 * 1000,
  });
  // Remember popup mode so the callback returns a self-closing page instead of a
  // full-page redirect (robust even if the pending DB record is missing).
  res.cookie("consensushealth_oauth_mode", isPopup ? "popup" : "redirect", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    path: "/",
    maxAge: 10 * 60 * 1000,
  });

  // E2E-only: optional per-login mock identity via ?e2e_user=… (never in production).
  if (CONSENSUSHEALTH_E2E) {
    const e2eKey = parseE2EUserKey(req.query.e2e_user);
    if (e2eKey) {
      res.cookie(E2E_USER_COOKIE, e2eKey, {
        signed: true,
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure(req),
        path: "/",
        maxAge: 10 * 60 * 1000,
      });
    } else {
      res.clearCookie(E2E_USER_COOKIE, { path: "/" });
    }
    if (e2eFailMode) {
      res.cookie(E2E_OAUTH_FAIL_COOKIE, e2eFailMode, {
        signed: true,
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure(req),
        path: "/",
        maxAge: 10 * 60 * 1000,
      });
    } else {
      res.clearCookie(E2E_OAUTH_FAIL_COOKIE, { path: "/" });
    }
  }

  const base = computeOAuthBase(req);
  const redirectUri = `${base}/auth/x/callback`;
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", TWITTER_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "users.read tweet.read");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  // Never log state, challenge, code, verifier, or the full authorize URL.
  let redirectOrigin = "";
  let redirectPath = "/auth/x/callback";
  try {
    const u = new URL(redirectUri);
    redirectOrigin = u.origin;
    redirectPath = u.pathname || redirectPath;
  } catch {
    redirectOrigin = "(invalid)";
  }
  console.log(
    JSON.stringify({
      event: "oauth_authorize_redirect",
      provider: "x",
      redirect_origin: redirectOrigin,
      redirect_path: redirectPath,
      mode: isPopup ? "popup" : "redirect",
      mock: X_OAUTH_MOCK || undefined,
    })
  );
  if (X_OAUTH_MOCK) {
    // Deterministic local/E2E path — no real X credentials or authorize URL.
    const mockCallback = new URL(`${base}/auth/x/callback`);
    mockCallback.searchParams.set("state", state);
    if (e2eFailMode === "deny") {
      // Provider denial: error + state, no code (popup mode cookie still set).
      mockCallback.searchParams.set("error", "access_denied");
    } else {
      mockCallback.searchParams.set("code", "mock_oauth_code");
    }
    res.redirect(mockCallback.toString());
    return;
  }
  res.redirect(url.toString());
}

app.get("/auth/x/login", startXAuth);
app.get("/auth/x", startXAuth);

if (process.env.NODE_ENV !== "production") {
  // DEV ONLY - REMOVE AFTER OAUTH
  app.post("/dev/login", (req, res) => {
  const b = req.body || {};
  const x_user_id = String(b.x_user_id || "").trim();
  const handle = String(b.handle || "").trim();
  if (!x_user_id || !handle) {
    return res.status(400).json({ error: "missing_fields" });
  }
  const payload: DevCookieUser = {
    x_user_id,
    handle,
    name: b.name ? String(b.name) : null,
    avatar_url: b.avatar_url ? String(b.avatar_url) : null,
    followers_count:
      Number.isFinite(Number(b.followers_count)) ? Number(b.followers_count) : null,
  };
  res.cookie("consensushealth_dev_user", payload, {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
    return res.json({ ok: true });
  });

  // DEV ONLY - REMOVE AFTER OAUTH
  app.post("/dev/logout", (_req, res) => {
    res.clearCookie("consensushealth_dev_user", { path: "/" });
    return res.json({ ok: true });
  });

  // DEV ONLY
  app.post("/dev/delete-user", async (req, res, next) => {
    try {
      const { handle } = req.body || {};

      if (!handle) {
        return res.status(400).json({ error: "handle required" });
      }

      await pool.query(
        "DELETE FROM community_users WHERE handle = $1",
        [String(handle).toLowerCase()]
      );

      return res.json({ deleted: true });
    } catch (err) {
      return next(err);
    }
  });
}

app.get("/auth/x/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const oauthError = String(req.query.error || "").trim();
    // Cookie mode is only a fallback when no pending row is consumed.
    const modeCookiePopup = String(req.cookies?.consensushealth_oauth_mode || "") === "popup";
    res.clearCookie("consensushealth_oauth_mode", { path: "/" });
    const e2eFailCookie = CONSENSUSHEALTH_E2E
      ? parseE2EOauthFailMode(req.signedCookies?.[E2E_OAUTH_FAIL_COOKIE])
      : null;
    if (CONSENSUSHEALTH_E2E) {
      res.clearCookie(E2E_OAUTH_FAIL_COOKIE, { path: "/" });
    }
    if (oauthError || !code || !state) {
      if (modeCookiePopup) {
        finishAuthResult(req, res, false, true);
        return;
      }
      res.status(400).send(oauthError ? `OAuth error: ${oauthError}` : "Missing OAuth code/state");
      return;
    }
    const stateCookie = String(req.cookies?.consensushealth_oauth_state || "");
    // Atomic: state + browser nonce + unexpired. Wrong browser does not burn the row.
    const pending = await consumeOAuthState(pool, state, stateCookie);
    res.clearCookie("consensushealth_oauth_state", { path: "/" });
    if (!pending) {
      console.error("[OAuth] Invalid/expired state or browser mismatch", {
        stateCookiePresent: Boolean(stateCookie),
      });
      if (!modeCookiePopup) {
        res.status(400).json({ error: "invalid_oauth_state" });
        return;
      }
      finishAuthResult(req, res, false, modeCookiePopup);
      return;
    }
    const isPopup = pending.mode === "popup";

    // E2E-only: force token/provider failure after a real popup-mode consume.
    if (CONSENSUSHEALTH_E2E && e2eFailCookie === "token") {
      finishAuthResult(req, res, false, isPopup);
      return;
    }

    const redirectUri = computeOAuthRedirectUri(req);
    let data: {
      id?: string;
      username?: string;
      name?: string;
      profile_image_url?: string;
      description?: string;
      created_at?: string;
      public_metrics?: { followers_count?: number };
    } | undefined;

    if (X_OAUTH_MOCK && code === "mock_oauth_code") {
      const e2eKey =
        CONSENSUSHEALTH_E2E
          ? parseE2EUserKey(req.signedCookies?.[E2E_USER_COOKIE])
          : null;
      if (CONSENSUSHEALTH_E2E) {
        res.clearCookie(E2E_USER_COOKIE, { path: "/" });
      }
      const mock = resolveE2EMockIdentity(e2eKey);
      data = {
        id: mock.id,
        username: mock.handle,
        name: mock.name,
        profile_image_url: String(process.env.X_OAUTH_MOCK_AVATAR || "").trim() || undefined,
        description: "mock oauth user",
        created_at: "2020-01-01T00:00:00.000Z",
        public_metrics: { followers_count: 42 },
      };
    } else {
      const tokenBody = new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: TWITTER_CLIENT_ID,
        redirect_uri: redirectUri,
        code_verifier: pending.code_verifier,
      });

      const tokenRes = await fetch("https://api.x.com/2/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: getBearerTokenBasicAuthHeader(TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET),
        },
        body: tokenBody,
      });
      if (!tokenRes.ok) {
        const txt = await tokenRes.text();
        logOAuthProviderFailure("[OAuth] Token exchange failed", tokenRes.status, txt);
        finishAuthResult(req, res, false, isPopup);
        return;
      }
      const tokenJson = (await tokenRes.json()) as { access_token?: string };
      const accessToken = tokenJson.access_token;
      if (!accessToken) {
        console.error("[OAuth] Token response missing access_token");
        finishAuthResult(req, res, false, isPopup);
        return;
      }

      const meRes = await fetch(
        "https://api.x.com/2/users/me?user.fields=profile_image_url,public_metrics,description,created_at",
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (!meRes.ok) {
        const txt = await meRes.text();
        logOAuthProviderFailure("[OAuth] /users/me failed", meRes.status, txt);
        finishAuthResult(req, res, false, isPopup);
        return;
      }
      const meJson = (await meRes.json()) as {
        data?: {
          id?: string;
          username?: string;
          name?: string;
          profile_image_url?: string;
          description?: string;
          created_at?: string;
          public_metrics?: { followers_count?: number };
        };
      };
      data = meJson.data;
    }
    if (!data?.id || !data?.username) {
      console.error("[OAuth] /users/me missing required fields");
      finishAuthResult(req, res, false, isPopup);
      return;
    }

    const xUserId =
      coerceXUserIdToDigitString(data.id) ??
      (typeof data.id === "string" ? data.id.trim() : "");
    if (!xUserId) {
      console.error("[OAuth] /users/me missing usable string id");
      finishAuthResult(req, res, false, isPopup);
      return;
    }
    const handle = String(data.username).toLowerCase();
    const name = data.name ? String(data.name) : null;
    const rawProfileImageUrl = data.profile_image_url ? String(data.profile_image_url) : null;
    const avatarUrl = rawProfileImageUrl ? rawProfileImageUrl.replace("_normal", "") : null;
    const xBio = String(data.description ?? "").trim() || null;
    const xAccountCreatedAt = String(data.created_at ?? "").trim() || null;
    const followersCount =
      typeof data.public_metrics?.followers_count === "number" ? data.public_metrics.followers_count : null;
    let enrichedBio: string | null = null;
    let enrichedAccountCreatedAt: string | null = null;
    if (PROFILE_ENRICHMENT_KEY && (!xBio || !xAccountCreatedAt)) {
      try {
        const enrichment = await fetchProfileEnrichmentFromTwitterApiIo(
          { xUserId, handle },
          PROFILE_ENRICHMENT_KEY
        );
        if (enrichment) {
          enrichedBio = enrichment.bio;
          enrichedAccountCreatedAt = enrichment.accountCreatedAt;
        }
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[auth-callback] profile enrichment failed:", e);
        }
      }
    }
    if (process.env.NODE_ENV !== "production") {
      console.log("[auth-callback] profile-fields", {
        x_user_id: xUserId,
        handle,
        profile_image_url: rawProfileImageUrl,
        persisted_avatar_url: avatarUrl,
        followers_count: followersCount,
        x_bio: Boolean(xBio),
        x_account_created_at: xAccountCreatedAt || null,
        enriched_bio: Boolean(enrichedBio),
        enriched_account_created_at: enrichedAccountCreatedAt || null,
      });
    }
    const persistedBio = xBio || enrichedBio;
    const persistedAccountCreatedAt = xAccountCreatedAt || enrichedAccountCreatedAt;

    // Link/login via x_user_id + handle only (no legacy community_users.id dependency).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await reconcileOauthCommunityUser(client, {
        xUserId,
        handle,
        name,
        avatarUrl,
        followersCount,
        bio: persistedBio,
        accountCreatedAt: persistedAccountCreatedAt,
      });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    // One-time permanent avatar capture. Fire-and-forget so a slow/failed
    // download never blocks login; ensureLocalAvatar is idempotent + never throws.
    void ensureLocalAvatar({ x_user_id: xUserId, avatar_url: avatarUrl }).catch(() => {});

    const sessionPayload: DevCookieUser = {
      x_user_id: xUserId,
      handle,
      name,
      avatar_url: avatarUrl,
      followers_count: followersCount,
    };
    res.cookie("consensushealth_session", sessionPayload, {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure(req),
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      signed: true,
    });
    finishAuthResult(req, res, true, isPopup);
  } catch (err) {
    console.error("[OAuth] callback exception:", err);
    next(err);
  }
});

app.get("/api/proposals", async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    const { isAdmin, items } = await loadAccessibleProposals(pool, user?.handle);
    res.json({
      generated_at: new Date().toISOString(),
      admin_galaxies: isAdmin,
      items,
    });
  } catch (err) {
    next(err);
  }
});

/** Public Consensus Overview aggregates (canonical user_proposal_stances only). */
app.get(
  "/api/consensus-overview",
  createStatsReadRateLimiter({ getClientIpKey: rateLimitClientIp }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      const { items } = await loadAccessibleProposals(pool, user?.handle);
      const publicItems = items.filter((p) => !p.admin_only);
      const ongoingIds = publicItems
        .filter((p) => String(p.status || "").toLowerCase() === "ongoing")
        .map((p) => String(p.id));
      const completedIds = publicItems
        .filter((p) => String(p.status || "").toLowerCase() === "final")
        .map((p) => String(p.id));
      const payload = await queryConsensusOverview(pool, { ongoingIds, completedIds });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

/** Name the PoW change fork easter-egg poll (separate from BIP stances). */
app.get(
  "/api/name-the-fork",
  createStatsReadRateLimiter({ getClientIpKey: rateLimitClientIp }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      const payload = await buildNameTheForkPayload(pool, {
        viewerXUserId: user?.x_user_id || null,
        viewerHandle: user?.handle || null,
        canModerate: isPrivilegedManualEditorHandle(user?.handle),
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/name-the-fork/vote",
  ...createStanceWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "not_logged_in" });
        return;
      }
      const candidateId = String(req.body?.candidate_id || "").trim();
      const result = await castNameTheForkVote(pool, {
        xUserId: user.x_user_id,
        candidateId,
        handle: user.handle,
        name: user.name,
        avatarUrl: user.avatar_url,
        avatarPath: null,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      const payload = await buildNameTheForkPayload(pool, {
        viewerXUserId: user.x_user_id,
        viewerHandle: user.handle,
        canModerate: isPrivilegedManualEditorHandle(user.handle),
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

app.delete(
  "/api/name-the-fork/vote",
  ...createStanceWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "not_logged_in" });
        return;
      }
      await removeNameTheForkVote(pool, user.x_user_id);
      const payload = await buildNameTheForkPayload(pool, {
        viewerXUserId: user.x_user_id,
        viewerHandle: user.handle,
        canModerate: isPrivilegedManualEditorHandle(user.handle),
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/name-the-fork/candidates",
  ...createStanceWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "not_logged_in" });
        return;
      }
      const result = await submitCustomNameTheForkCandidate(pool, {
        xUserId: user.x_user_id,
        displayName: req.body?.display_name ?? req.body?.name,
        handle: user.handle,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      const payload = await buildNameTheForkPayload(pool, {
        viewerXUserId: user.x_user_id,
        viewerHandle: user.handle,
        canModerate: isPrivilegedManualEditorHandle(user.handle),
      });
      res.status(201).json(payload);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/name-the-fork/admin/approve",
  ...createAdminWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      if (!user || !isPrivilegedManualEditorHandle(user.handle)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const candidateId = String(req.body?.candidate_id || "").trim();
      const result = await approveNameTheForkCandidate(pool, {
        candidateId,
        adminXUserId: user.x_user_id,
        adminHandle: user.handle,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      const payload = await buildNameTheForkPayload(pool, {
        viewerXUserId: user.x_user_id,
        viewerHandle: user.handle,
        canModerate: true,
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/name-the-fork/admin/reject",
  ...createAdminWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      if (!user || !isPrivilegedManualEditorHandle(user.handle)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const candidateId = String(req.body?.candidate_id || "").trim();
      const result = await rejectNameTheForkCandidate(pool, {
        candidateId,
        adminXUserId: user.x_user_id,
        adminHandle: user.handle,
        reason: req.body?.reason ?? null,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      const payload = await buildNameTheForkPayload(pool, {
        viewerXUserId: user.x_user_id,
        viewerHandle: user.handle,
        canModerate: true,
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/api/name-the-fork/admin/hide",
  ...createAdminWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      if (!user || !isPrivilegedManualEditorHandle(user.handle)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const candidateId = String(req.body?.candidate_id || "").trim();
      const result = await hideNameTheForkCandidate(pool, {
        candidateId,
        adminHandle: user.handle,
        adminXUserId: user.x_user_id,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      const payload = await buildNameTheForkPayload(pool, {
        viewerXUserId: user.x_user_id,
        viewerHandle: user.handle,
        canModerate: true,
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

app.get("/api/community", async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    const access = await resolveProposalAccessAsync(pool, {
      rawProposal: req.query.proposal ?? req.query.bip,
      sessionHandle: user?.handle,
    });
    if (!access.known) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }

    const withStance = await loadMergedCommunityUsersWithStance(access.proposalId);

    if (process.env.NODE_ENV !== "production") {
      console.log("[api/community] counts", {
        proposal_id: access.proposalId,
        final_with_stance_count: withStance.length,
      });
    }

    // BIP110: keep legacy bare-array response for public clients.
    if (access.proposalId === DEFAULT_PROPOSAL_ID) {
      res.json(withStance);
      return;
    }
    res.json({ proposal_id: access.proposalId, accounts: withStance });
  } catch (err) {
    next(err);
  }
});

const STANCE_CSV_EXPORT_ROUTES: Array<{ path: string; stance: StanceValue }> = [
  { path: "/api/stances/export-against.csv", stance: "against" },
  { path: "/api/stances/export-neutral.csv", stance: "neutral" },
  { path: "/api/stances/export-approve.csv", stance: "approve" },
];

for (const route of STANCE_CSV_EXPORT_ROUTES) {
  app.get(route.path, async (req, res, next) => {
    try {
      const user = getSessionUser(req);
      const access = await resolveProposalAccessAsync(pool, {
      rawProposal: req.query.proposal ?? req.query.bip,
      sessionHandle: user?.handle,
    });
    if (!access.known) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
      const mergedRows = await loadMergedCommunityUsersWithStance(access.proposalId);
      const { filename, content } = buildStanceCsvExport(mergedRows, route.stance);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(content);
    } catch (err) {
      next(err);
    }
  });
}

// Serve stored avatars (seed files + one-time downloaded profile images) from
// the configured avatars directory. Immutable: filenames are content-stable.
app.use(
  "/avatars",
  express.static(AVATARS_DIR, {
    fallthrough: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);

app.get(
  "/api/avatar-proxy",
  createAvatarProxyRateLimiter({ getClientIpKey: rateLimitClientIp }),
  async (req, res, next) => {
  try {
    const rawUrl = String(req.query.url ?? "").trim();
    if (!rawUrl) {
      res.status(400).json({ error: "missing_url" });
      return;
    }
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      res.status(400).json({ error: "invalid_url" });
      return;
    }
    if (!["http:", "https:"].includes(target.protocol)) {
      res.status(400).json({ error: "invalid_protocol" });
      return;
    }
    if (!isAllowedAvatarHost(target.hostname)) {
      res.status(400).json({ error: "host_not_allowed" });
      return;
    }

    const upstream = await fetch(target.toString(), {
      redirect: "follow",
      headers: {
        "user-agent": "ConsensusHealthAvatarProxy/1.0",
        accept: "image/*,*/*;q=0.8",
      },
    });

    if (!upstream.ok) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[avatar-proxy] upstream-failed", {
          url: target.toString(),
          status: upstream.status,
        });
      }
      res.status(502).json({ error: "upstream_fetch_failed", status: upstream.status });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    // X/Twitter often sends cache headers that discourage browser caching (e.g. private).
    // The image URL path usually changes when a user changes their photo, so long public caching is safe.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(body);
  } catch (err) {
    next(err);
  }
});

app.get("/api/me", async (req, res, next) => {
  try {
    const user = getSessionUser(req);

    if (!user) {
      res.json(null);
      return;
    }

    const result = await pool.query(
      `
      SELECT
        cu.*,
        cu.account_created_at AS "accountCreatedAt"
      FROM community_users cu
      WHERE cu.x_user_id = $1
      `,
      [user.x_user_id]
    );

    const row = result.rows[0] || null;
    if (!row) {
      res.json(null);
      return;
    }

    const stancesRes = await pool.query(
      `SELECT proposal_id, stance FROM user_proposal_stances WHERE x_user_id = $1`,
      [user.x_user_id]
    );
    const proposal_stances: Record<string, string | null> = Object.fromEntries(
      listEnabledProposals().map((proposal) => [proposal.id, null])
    );
    for (const r of stancesRes.rows) {
      const pid = String(r.proposal_id || "");
      const st = normalizeStanceValue(r.stance);
      if (pid in proposal_stances) proposal_stances[pid] = st;
    }
    const proposal_explanations = await loadExplanationsForUser(pool, user.x_user_id);
    // Canonical: proposal tables only (legacy community_users.stance is mirror, not read).
    res.json({
      ...row,
      stance: proposal_stances.bip110 ?? null,
      proposal_stances,
      proposal_explanations,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/me/preferences", async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    if (!user) {
      res.status(401).json({ error: "not_logged_in" });
      return;
    }

    const equalAvatarSize = Boolean(req.body?.equal_avatar_size);
    const result = await pool.query(
      `
      UPDATE community_users
      SET equal_avatar_size = $2,
          updated_at = NOW()
      WHERE x_user_id = $1
      RETURNING x_user_id, equal_avatar_size
      `,
      [user.x_user_id, equalAvatarSize]
    );

    res.json(result.rows[0] || { x_user_id: user.x_user_id, equal_avatar_size: equalAvatarSize });
  } catch (err) {
    next(err);
  }
});

app.post(
  "/api/me/delete",
  ...createAccountDeletionRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  createAccountDeletionHandler({
    pool,
    getSessionUser,
    avatarsDir: AVATARS_DIR,
    invalidateStatsCache,
    clearSessionCookie: (res) => {
      res.clearCookie("consensushealth_session", { path: "/" });
      if (process.env.NODE_ENV !== "production") {
        res.clearCookie("consensushealth_dev_user", { path: "/" });
      }
    },
  })
);

app.post(
  "/api/stance",
  ...createStanceWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  async (req, res, next) => {
  try {
    if (!SELF_STANCE_UPDATES_ENABLED) {
      res.status(409).json({
        error: "stance_updates_restricted",
        message: "Position updates are currently managed by the site administrator.",
      });
      return;
    }

    const user = getSessionUser(req);

    if (!user) {
      res.status(401).json({ error: "not_logged_in" });
      return;
    }

    const requestedStance = normalizeStanceValue(req.body?.stance);
    if (!requestedStance) {
      res.status(400).json({ error: "invalid_stance" });
      return;
    }

    const access = await resolveProposalAccessAsync(pool, {
      rawProposal: req.body?.proposal ?? req.body?.proposal_id ?? req.query.proposal,
      sessionHandle: user.handle,
    });
    if (!access.known) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }

    const proposalMeta = getProposalById(access.proposalId);
    if (isFinalProposalStatus(proposalMeta?.status)) {
      res.status(409).json({
        error: "proposal_stances_frozen",
        message: "This proposal is a final locked snapshot. Positions can no longer be changed.",
      });
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("[stance-save] session-user", {
        x_user_id: user.x_user_id,
        handle: user.handle,
        proposal_id: access.proposalId,
        avatar_url_session: user.avatar_url,
        followers_count_session: user.followers_count,
        requested_stance: String(req.body?.stance ?? ""),
        normalized_stance: requestedStance,
      });
    }

    const client = await pool.connect();
    let row: Record<string, unknown>;
    try {
      await client.query("BEGIN");
      const result = await upsertStanceWithHistory(client, {
        xUserId: user.x_user_id,
        handle: user.handle,
        name: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
        followersCount: user.followers_count ?? null,
        stance: requestedStance,
        changedBy: "user",
        proposalId: access.proposalId,
      });
      row = result.row;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    if (process.env.NODE_ENV !== "production") {
      console.log("[stance-save] persisted-row", {
        x_user_id: row?.x_user_id,
        handle: row?.handle,
        followers_after: row?.followers_count ?? null,
        avatar_url_persisted: row?.avatar_url,
        stance_persisted: row?.stance,
      });
    }

    // One-time permanent avatar capture for new users choosing a stance.
    // Fire-and-forget: never block or fail stance submission.
    void ensureLocalAvatar({
      x_user_id: user.x_user_id,
      avatar_url: user.avatar_url ?? (row?.avatar_url != null ? String(row.avatar_url) : null),
    }).catch(() => {});

    res.json(row);
  } catch (err) {
    next(err);
  }
});

const stanceExplanationHandlers = createStanceExplanationHandlers({
  getSessionUser,
  resolveProposalAccess: async ({ rawProposal, sessionHandle }) =>
    resolveProposalAccessAsync(pool, { rawProposal, sessionHandle }),
  pool,
  normalizeStanceValue,
  verifyAndUpsertStanceExplanation,
  confirmExplanationForStance,
  deleteStanceExplanation,
});

app.put(
  "/api/stance-explanation",
  ...createStanceExplanationWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  stanceExplanationHandlers.putStanceExplanation
);
app.delete(
  "/api/stance-explanation",
  ...createStanceExplanationWriteRateLimiters({
    getXUserId: rateLimitUserId,
    getClientIpKey: rateLimitClientIp,
  }),
  stanceExplanationHandlers.deleteStanceExplanationHandler
);

app.post("/api/admin/remove-user", async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    if (!user || !isPrivilegedManualEditorHandle(user.handle)) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[admin-remove-user] forbidden", { requester: normalizeHandle(user?.handle) || null });
      }
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const target = resolveRemovalTarget({
      handle: req.body?.handle,
      x_user_id: req.body?.x_user_id,
      requesterHandle: user.handle,
    });
    if (!target.ok) {
      res.status(400).json({ error: target.error });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let existingRow: Record<string, unknown> | null = null;
      if (target.xUserId) {
        const byId = await client.query("SELECT * FROM community_users WHERE x_user_id = $1 LIMIT 1", [
          target.xUserId,
        ]);
        existingRow = (byId.rows[0] ?? null) as Record<string, unknown> | null;
      }
      if (!existingRow && target.handle) {
        const byHandle = await client.query(
          "SELECT * FROM community_users WHERE lower(coalesce(handle, '')) = $1 LIMIT 1",
          [target.handle]
        );
        existingRow = (byHandle.rows[0] ?? null) as Record<string, unknown> | null;
      }

      const resolvedHandle =
        normalizeRemovedHandle(existingRow?.handle ?? target.handle) || null;
      const resolvedXUserId =
        normalizeRemovedXUserId(existingRow?.x_user_id ?? target.xUserId) || null;
      if (!resolvedHandle && !resolvedXUserId) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "target_required" });
        return;
      }
      if (resolvedHandle && resolvedHandle === normalizeHandle(user.handle)) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "cannot_remove_self" });
        return;
      }

      // Record removal (idempotent). Partial unique indexes can't share one ON CONFLICT target.
      const existingRemoval = await client.query(
        `
        SELECT id FROM removed_community_users
        WHERE ($1::text IS NOT NULL AND lower(handle) = $1)
           OR ($2::text IS NOT NULL AND x_user_id = $2)
        LIMIT 1
        `,
        [resolvedHandle, resolvedXUserId]
      );
      if (existingRemoval.rows.length === 0) {
        await client.query(
          `INSERT INTO removed_community_users (handle, x_user_id, removed_by) VALUES ($1, $2, $3)`,
          [resolvedHandle, resolvedXUserId, normalizeHandle(user.handle)]
        );
      } else if (resolvedHandle && resolvedXUserId) {
        await client.query(
          `
          UPDATE removed_community_users
          SET handle = COALESCE(handle, $1),
              x_user_id = COALESCE(x_user_id, $2)
          WHERE id = $3
          `,
          [resolvedHandle, resolvedXUserId, existingRemoval.rows[0].id]
        );
      }

      if (resolvedXUserId) {
        await client.query(`DELETE FROM community_users WHERE x_user_id = $1`, [resolvedXUserId]);
      } else if (resolvedHandle) {
        await client.query(`DELETE FROM community_users WHERE lower(coalesce(handle, '')) = $1`, [
          resolvedHandle,
        ]);
      }

      await client.query("COMMIT");
      if (process.env.NODE_ENV !== "production") {
        console.log("[admin-remove-user] removed", {
          requester: normalizeHandle(user.handle),
          target_handle: resolvedHandle,
          target_x_user_id: resolvedXUserId,
        });
      }
      res.json({ removed: true, handle: resolvedHandle, x_user_id: resolvedXUserId });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

app.post(
  "/api/admin/stance",
  createAdminStanceHandler({
    getSessionUser,
    isPrivilegedManualEditorHandle,
    normalizeHandle,
    normalizeStanceValue,
    resolveProposalAccess: async ({ rawProposal, sessionHandle }) =>
      resolveProposalAccessAsync(pool, { rawProposal, sessionHandle }),
    getProposalById,
    isFinalProposalStatus,
    pool,
    upsertStanceWithHistory,
  })
);

app.get(
  "/api/stance-playback-sequence",
  createStatsReadRateLimiter({ getClientIpKey: rateLimitClientIp }),
  async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    const access = await resolveProposalAccessAsync(pool, {
      rawProposal: req.query.proposal ?? req.query.bip,
      sessionHandle: user?.handle,
    });
    if (!access.known) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
    const proposalId = access.proposalId;
    const rowsRes = await pool.query(
      `
      WITH first_user AS (
        SELECT DISTINCT ON (sh.x_user_id)
          sh.x_user_id,
          sh.changed_at AS first_at,
          sh.new_stance
        FROM user_proposal_stance_history sh
        WHERE sh.changed_by = 'user'
          AND sh.proposal_id = $1
        ORDER BY sh.x_user_id ASC, sh.changed_at ASC
      )
      SELECT
        f.x_user_id,
        lower(trim(coalesce(cu.handle, ''))) AS handle,
        f.new_stance AS stance,
        f.first_at
      FROM first_user f
      INNER JOIN community_users cu ON cu.x_user_id = f.x_user_id
      WHERE trim(coalesce(cu.handle, '')) <> ''
      ORDER BY f.first_at ASC
      LIMIT 2000
      `,
      [proposalId]
    );

    const items = rowsRes.rows.map((r) => ({
      x_user_id: String(r.x_user_id ?? ""),
      handle: String(r.handle ?? "").trim(),
      stance: String(r.stance ?? "").trim(),
      changed_at: new Date(r.first_at).toISOString(),
    }));

    res.json({ proposal_id: proposalId, items });
  } catch (err) {
    next(err);
  }
});

app.get(
  "/api/stances/new",
  createStatsReadRateLimiter({ getClientIpKey: rateLimitClientIp }),
  async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    const access = await resolveProposalAccessAsync(pool, {
      rawProposal: req.query.proposal ?? req.query.bip,
      sessionHandle: user?.handle,
    });
    if (!access.known) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
    const afterRaw = String(req.query.afterEventId ?? "").trim();
    const limitRaw = String(req.query.limit ?? "").trim();
    const afterEventId =
      afterRaw && Number.isFinite(Number(afterRaw)) && Number(afterRaw) > 0
        ? Math.trunc(Number(afterRaw))
        : null;
    const limit = clampNewStancesLimit(limitRaw || 9);
    const items = await queryNewStanceEvents(pool, {
      afterEventId,
      limit,
      proposalId: access.proposalId,
    });
    res.json({
      generated_at: new Date().toISOString(),
      proposal_id: access.proposalId,
      items,
    });
  } catch (err) {
    next(err);
  }
});

app.get(
  "/api/stance-history",
  createStatsReadRateLimiter({ getClientIpKey: rateLimitClientIp }),
  async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    const access = await resolveProposalAccessAsync(pool, {
      rawProposal: req.query.proposal ?? req.query.bip,
      sessionHandle: user?.handle,
    });
    if (!access.known) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
    const proposalId = access.proposalId;
    const historyTable = "user_proposal_stance_history";

    const limitRaw = String(req.query.limit ?? "").trim();
    const cursorRaw = String(req.query.cursor ?? "").trim();
    const wantsPage = Boolean(limitRaw || cursorRaw || String(req.query.page ?? "").trim() === "1");

    if (wantsPage) {
      const limit = Number(limitRaw || 10);
      const cursor = decodeStanceHistoryCursor(cursorRaw);
      if (cursorRaw && !cursor) {
        res.status(400).json({ error: "invalid_cursor" });
        return;
      }
      const page = await queryRecentStanceHistoryPage({
        limit: Number.isFinite(limit) ? limit : 10,
        cursor,
        proposalId,
      });
      res.json({
        generated_at: new Date().toISOString(),
        proposal_id: proposalId,
        items: page.items.map((item) => ({
          id: item.id,
          handle: item.handle,
          display_name: item.display_name,
          followers_count: item.followers_count,
          previous_stance: item.previous_stance,
          new_stance: item.new_stance,
          changed_at: item.changed_at,
          changed_by: item.changed_by,
        })),
        next_cursor: page.next_cursor,
        has_more: page.has_more,
      });
      return;
    }

    const xUserId = String(req.query.x_user_id ?? "").trim();
    const handle = normalizeHandle(req.query.handle);
    const where: string[] = [];
    const params: string[] = [];
    params.push(proposalId);
    where.push(`sh.proposal_id = $${params.length}`);
    if (xUserId) {
      params.push(xUserId);
      where.push(`sh.x_user_id = $${params.length}`);
    }
    if (handle) {
      params.push(handle);
      where.push(`lower(coalesce(cu.handle, '')) = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const historyRes = await pool.query(
      `
      SELECT
        sh.id,
        sh.x_user_id,
        cu.handle,
        cu.name,
        cu.followers_count,
        sh.previous_stance,
        sh.new_stance,
        sh.changed_at,
        sh.changed_by
      FROM ${historyTable} sh
      LEFT JOIN community_users cu ON cu.x_user_id = sh.x_user_id
      ${whereSql}
      ORDER BY sh.changed_at ASC
      LIMIT 3000
      `,
      params
    );

    const dailyTotalsRes = await pool.query(
      `
      SELECT
        date_trunc('day', sh.changed_at)::date AS day,
        COUNT(*)::int AS total_changes
      FROM ${historyTable} sh
      LEFT JOIN community_users cu ON cu.x_user_id = sh.x_user_id
      ${whereSql}
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      params
    );

    const dailyTransitionsRes = await pool.query(
      `
      SELECT
        date_trunc('day', sh.changed_at)::date AS day,
        sh.previous_stance AS "from",
        sh.new_stance AS "to",
        COUNT(*)::int AS count
      FROM ${historyTable} sh
      LEFT JOIN community_users cu ON cu.x_user_id = sh.x_user_id
      ${whereSql}
      GROUP BY 1,2,3
      ORDER BY 1 ASC, count DESC
      `,
      params
    );

    res.json({
      generated_at: new Date().toISOString(),
      proposal_id: proposalId,
      history: historyRes.rows.map((r) => {
        const mapped = mapStanceHistoryPublicRow(r as Record<string, unknown>);
        return {
          id: mapped.id,
          handle: mapped.handle,
          display_name: mapped.display_name,
          followers_count: mapped.followers_count,
          previous_stance: mapped.previous_stance,
          new_stance: mapped.new_stance,
          changed_at: mapped.changed_at,
          changed_by: mapped.changed_by,
        };
      }),
      daily_totals: dailyTotalsRes.rows.map((r) => ({
        day: String(r.day),
        total_changes: Number(r.total_changes) || 0,
      })),
      daily_transitions: dailyTransitionsRes.rows.map((r) => ({
        day: String(r.day),
        from: r.from ? String(r.from) : null,
        to: String(r.to),
        count: Number(r.count) || 0,
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.get(
  "/api/stats",
  createStatsReadRateLimiter({ getClientIpKey: rateLimitClientIp }),
  async (req, res, next) => {
  try {
    const user = getSessionUser(req);
    const access = await resolveProposalAccessAsync(pool, {
      rawProposal: req.query.proposal ?? req.query.bip,
      sessionHandle: user?.handle,
    });
    if (!access.known) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
    const proposalId = access.proposalId;
    const handlerStarted = Date.now();
    const now = Date.now();
    const cachedEntry = statsResponseCacheByProposal.get(proposalId);
    if (cachedEntry && cachedEntry.expiresAt > now) {
      const cached = {
        ...cachedEntry.payload,
        _timing: {
          total_ms: Date.now() - handlerStarted,
          db_ms: 0,
          cache_hit: true,
        },
      };
      if (!IS_PROD) {
        console.log("[api/stats] timing", cached._timing);
      }
      res.json(cached);
      return;
    }

    const toNum = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const dbStarted = Date.now();
    const [
      aggRes,
      topRowsRes,
      changedEverRes,
      changes7dRes,
      totalChangesRes,
      transitionCountsRes,
      flowsRes,
    ] = await runStatsQueries(pool, proposalId);
    const recentPage = await queryRecentStanceHistoryPage({
      limit: 10,
      cursor: null,
      proposalId,
    });
    const dbMs = Date.now() - dbStarted;

    const agg = aggRes.rows[0] || {};
    const counts = {
      against: toNum(agg.against_count),
      neutral: toNum(agg.neutral_count),
      approve: toNum(agg.approve_count),
    };
    const totalUsersWithStance = toNum(agg.total_users_with_stance);
    const denom = totalUsersWithStance || 1;
    const percentages = {
      against: Math.round((counts.against / denom) * 1000) / 10,
      neutral: Math.round((counts.neutral / denom) * 1000) / 10,
      approve: Math.round((counts.approve / denom) * 1000) / 10,
    };
    const followersTotal = {
      against: toNum(agg.against_followers_total),
      neutral: toNum(agg.neutral_followers_total),
      approve: toNum(agg.approve_followers_total),
    };
    const followersAvg = {
      against: toNum(agg.against_followers_avg),
      neutral: toNum(agg.neutral_followers_avg),
      approve: toNum(agg.approve_followers_avg),
    };

    const topAccount: {
      against: { handle: string | null; followers_count: number | null };
      neutral: { handle: string | null; followers_count: number | null };
      approve: { handle: string | null; followers_count: number | null };
    } = {
      against: { handle: null, followers_count: null },
      neutral: { handle: null, followers_count: null },
      approve: { handle: null, followers_count: null },
    };
    for (const r of topRowsRes.rows) {
      const stance = String(r.stance_norm || "");
      if (stance === "against" || stance === "neutral" || stance === "approve") {
        topAccount[stance] = {
          handle: r.handle ? String(r.handle) : null,
          followers_count: r.followers_count == null ? null : toNum(r.followers_count),
        };
      }
    }

    const recent_changes = recentPage.items.map((item) => ({
      id: item.id,
      handle: item.handle,
      display_name: item.display_name,
      followers_count: item.followers_count,
      from: item.from,
      to: item.to,
      previous_stance: item.previous_stance,
      new_stance: item.new_stance,
      changed_at: item.changed_at,
      changed_by: item.changed_by,
    }));

    const payload: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      proposal_id: proposalId,
      total_users_with_stance: totalUsersWithStance,
      counts,
      percentages,
      followers_total: followersTotal,
      followers_avg: followersAvg,
      top_account: topAccount,
      changed_ever: toNum(changedEverRes.rows[0]?.changed_ever),
      changes_last_7d: toNum(changes7dRes.rows[0]?.changes_last_7d),
      total_changes: toNum(totalChangesRes.rows[0]?.total_changes),
      transition_counts: transitionCountsRes.rows.map((r) => ({
        from: r.from === null ? null : String(r.from),
        to: String(r.to),
        count: toNum(r.count),
      })),
      recent_changes,
      recent_changes_next_cursor: recentPage.next_cursor,
      recent_changes_has_more: recentPage.has_more,
      flows_last_7d: flowsRes.rows.map((r) => ({
        from: r.from === null ? null : String(r.from),
        to: String(r.to),
        count: toNum(r.count),
      })),
    };

    statsResponseCacheByProposal.set(proposalId, {
      expiresAt: Date.now() + STATS_CACHE_TTL_MS,
      payload,
    });

    const timing = {
      total_ms: Date.now() - handlerStarted,
      db_ms: dbMs,
      cache_hit: false,
    };
    if (!IS_PROD) {
      console.log("[api/stats] timing", timing);
    }

    res.json({
      ...payload,
      _timing: timing,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/logout", async (req, res, next) => {
  try {
    res.clearCookie("consensushealth_session", { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use(
  "/api",
  createHealthRouter({
    pool,
    serviceName: "consensushealth-api",
  })
);

app.get("/api/public-config", (_req, res) => {
  const contactEmail = getContactEmail();
  const ttl = Number.isFinite(SESSION_TTL_DAYS) && SESSION_TTL_DAYS > 0 ? Math.floor(SESSION_TTL_DAYS) : 30;
  res.setHeader("Cache-Control", "no-store");
  res.json({
    contact_email: contactEmail,
    session_ttl_days: ttl,
    backup_retention_days: BACKUP_RETENTION_DAYS,
    trust_proxy_mode: clientIpConfig.mode,
  });
});

if (IS_PROD || E2E_SERVE_DIST) {
  if (!fs.existsSync(DIST_PATH)) {
    console.warn(`[ConsensusHealth server] dist folder not found at ${DIST_PATH}. Run: npm run build`);
  } else {
    app.use(
      express.static(DIST_PATH, {
        index: false,
        setHeaders(res, filePath) {
          const fp = filePath.replace(/\\/g, "/");
          if (fp.includes("/avatars/")) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else if (fp.includes("/assets/")) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      })
    );
    app.get(/^(?!\/(?:api|auth|dev)(?:\/|$)).*$/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(DIST_PATH, "index.html"));
    });
  }
}

const errorMonitor: ErrorMonitoringHandle = await initErrorMonitoring(process.env);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("UNHANDLED_ERROR:", err instanceof Error ? err.message : "error");
  errorMonitor.captureException(err, { route: "unhandled" });
  res.status(500).json({ error: "Internal server error" });
});

await initDb();
await cleanupExpiredSessions();
logConfig();

export { app, pool, initDb };

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun || FORCE_LISTEN) {
  const server = app.listen(PORT, () => {
    console.log("ConsensusHealth API running");
    console.log("Using database:", connectionString.replace(/:(?:[^@]*)@/, ":***@"));
    console.log(`ConsensusHealth server listening on http://localhost:${PORT}`);
    if (IS_PROD || E2E_SERVE_DIST) {
      console.log(`[ConsensusHealth server] Serving frontend from: ${DIST_PATH}`);
    }
  });
  gracefulShutdown(server, pool);
}
