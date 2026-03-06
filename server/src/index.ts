import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import { logConfig } from "./config/appUrl.js";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });

const PORT = Number(process.env.PORT || 8787);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const APP_ORIGIN_ENV = (process.env.APP_ORIGIN || "").trim();
const APP_URL_ENV = (process.env.APP_URL || "").trim();
const DIST_PATH = path.resolve(process.cwd(), "dist");
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const TWITTER_CLIENT_ID = process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID || "";
const TWITTER_CLIENT_SECRET = process.env.X_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET || "";
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const SESSION_SECRET = process.env.SESSION_SECRET || "";
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

function withWwwVariant(origin: string): string[] {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) {
      const noWww = host.slice(4);
      return [origin, `${url.protocol}//${noWww}${url.port ? `:${url.port}` : ""}`];
    }
    return [origin, `${url.protocol}//www.${host}${url.port ? `:${url.port}` : ""}`];
  } catch {
    return [origin];
  }
}

function buildAllowedOrigins(): Set<string> {
  const set = new Set<string>();
  const add = (value: string): void => {
    const v = value.trim();
    if (!v) return;
    for (const item of withWwwVariant(v)) set.add(item);
  };
  add(APP_ORIGIN_ENV);
  add(APP_URL_ENV);
  set.add("http://localhost:5173");
  return set;
}

const allowedOrigins = buildAllowedOrigins();

const app = express();
app.set("trust proxy", 1);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(SESSION_SECRET));

type PendingAuth = {
  code_verifier: string;
  createdAt: number;
};

type SessionUser = {
  x_user_id: string;
  handle: string;
  name: string | null;
  avatar_url: string | null;
  followers_count: number | null;
  stance: string | null;
};

const pendingAuth = new Map<string, PendingAuth>();

function isAllowedAvatarHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "pbs.twimg.com" || host.endsWith(".twimg.com");
}

function normalizeHandle(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^@+/, "");
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
}

async function cleanupExpiredSessions(): Promise<void> {
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
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
  const code_verifier = createCodeVerifier();
  const challenge = createCodeChallenge(code_verifier);
  pendingAuth.set(state, { code_verifier, createdAt: Date.now() });
  res.cookie("consensushealth_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(req),
    path: "/",
    maxAge: 10 * 60 * 1000,
  });

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

  console.log("[oauth] base=%s redirect_uri=%s", base, redirectUri);
  console.log("[OAuth] authorize url:", url.toString());
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
    if (!code || !state) {
      res.status(400).send("Missing OAuth code/state");
      return;
    }
    const stateCookie = String(req.cookies?.consensushealth_oauth_state || "");
    const pending = pendingAuth.get(state);
    pendingAuth.delete(state);
    res.clearCookie("consensushealth_oauth_state", { path: "/" });
    if (!pending || stateCookie !== state || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      console.error("[OAuth] Invalid/expired state", { hasPending: Boolean(pending), stateCookiePresent: Boolean(stateCookie) });
      res.status(500).json({ error: "oauth_failed" });
      return;
    }

    const redirectUri = computeOAuthRedirectUri(req);
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
      console.error("[OAuth] Token exchange failed:", tokenRes.status, txt);
      res.status(500).json({ error: "oauth_failed" });
      return;
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      console.error("[OAuth] Token response missing access_token");
      res.status(500).json({ error: "oauth_failed" });
      return;
    }

    const meRes = await fetch(
      "https://api.x.com/2/users/me?user.fields=profile_image_url,public_metrics",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!meRes.ok) {
      const txt = await meRes.text();
      console.error("[OAuth] /users/me failed:", meRes.status, txt);
      res.status(500).json({ error: "oauth_failed" });
      return;
    }
    const meJson = (await meRes.json()) as {
      data?: {
        id?: string;
        username?: string;
        name?: string;
        profile_image_url?: string;
        public_metrics?: { followers_count?: number };
      };
    };
    const data = meJson.data;
    if (!data?.id || !data?.username) {
      console.error("[OAuth] /users/me missing required fields");
      res.status(500).json({ error: "oauth_failed" });
      return;
    }

    const xUserId = String(data.id);
    const handle = String(data.username).toLowerCase();
    const name = data.name ? String(data.name) : null;
    const rawProfileImageUrl = data.profile_image_url ? String(data.profile_image_url) : null;
    const avatarUrl = rawProfileImageUrl ? rawProfileImageUrl.replace("_normal", "") : null;
    const followersCount =
      typeof data.public_metrics?.followers_count === "number" ? data.public_metrics.followers_count : null;
    if (process.env.NODE_ENV !== "production") {
      console.log("[auth-callback] profile-fields", {
        x_user_id: xUserId,
        handle,
        profile_image_url: rawProfileImageUrl,
        persisted_avatar_url: avatarUrl,
        followers_count: followersCount,
      });
    }

    // Link/login logic:
    // 1) find by x_user_id and update profile fields (preserve stance)
    // 2) else find by handle (case-insensitive), attach x_user_id and preserve stance
    // 3) else create brand new row with stance NULL
    // Safety: if both x_user_id row and handle row exist, merge to one row preferring non-null stance.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const byIdRes = await client.query(
        `SELECT * FROM community_users WHERE x_user_id = $1 LIMIT 1`,
        [xUserId]
      );
      const byHandleRes = await client.query(
        `
          SELECT * FROM community_users
          WHERE lower(handle) = $1
          ORDER BY (stance IS NOT NULL) DESC, updated_at DESC NULLS LAST
          LIMIT 1
        `,
        [handle]
      );

      const byId = byIdRes.rows[0] as { id: number; stance?: string | null } | undefined;
      const byHandle = byHandleRes.rows[0] as { id: number; stance?: string | null } | undefined;

      if (byId && byHandle && byId.id !== byHandle.id) {
        const byIdHasStance = Boolean(byId.stance);
        const byHandleHasStance = Boolean(byHandle.stance);
        const winner = byHandleHasStance && !byIdHasStance ? byHandle : byId;
        const loser = winner.id === byId.id ? byHandle : byId;

        await client.query(
          `
          UPDATE community_users
          SET x_user_id = $1,
              handle = $2,
              name = $3,
              avatar_url = $4,
              followers_count = $5,
              updated_at = now()
          WHERE id = $6
        `,
          [xUserId, handle, name, avatarUrl, followersCount, winner.id]
        );
        await client.query(`DELETE FROM community_users WHERE id = $1`, [loser.id]);
      } else if (byId) {
        await client.query(
          `
          UPDATE community_users
          SET handle = $2,
              name = $3,
              avatar_url = $4,
              followers_count = $5,
              updated_at = now()
          WHERE x_user_id = $1
        `,
          [xUserId, handle, name, avatarUrl, followersCount]
        );
      } else {
        if (byHandle) {
          await client.query(
            `
            UPDATE community_users
            SET x_user_id = $1,
                handle = $2,
                name = $3,
                avatar_url = $4,
                followers_count = $5,
                updated_at = now()
            WHERE id = $6
          `,
            [xUserId, handle, name, avatarUrl, followersCount, byHandle.id]
          );
        } else {
          await client.query(
            `
            INSERT INTO community_users (x_user_id, handle, name, avatar_url, followers_count, stance, updated_at)
            VALUES ($1, $2, $3, $4, $5, NULL, now())
          `,
            [xUserId, handle, name, avatarUrl, followersCount]
          );
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

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
    res.redirect(frontendRedirect(req, "/"));
  } catch (err) {
    console.error("[OAuth] callback exception:", err);
    next(err);
  }
});

app.get("/api/community", async (_req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM community_users");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get("/api/avatar-proxy", async (req, res, next) => {
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
    const cacheControl =
      upstream.headers.get("cache-control") || "public, max-age=86400, stale-while-revalidate=604800";
    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl);
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
      "SELECT * FROM community_users WHERE x_user_id = $1",
      [user.x_user_id]
    );

    res.json(result.rows[0] || null);
  } catch (err) {
    next(err);
  }
});

app.post("/api/stance", async (req, res, next) => {
  try {
    const user = getSessionUser(req);

    if (!user) {
      res.status(401).json({ error: "not_logged_in" });
      return;
    }

    const stance = String(req.body?.stance || "").toLowerCase();

    if (!["against", "neutral", "approve", "support"].includes(stance)) {
      res.status(400).json({ error: "invalid_stance" });
      return;
    }
    const normalized = stance === "support" ? "approve" : stance;
    if (process.env.NODE_ENV !== "production") {
      console.log("[stance-save] session-user", {
        x_user_id: user.x_user_id,
        handle: user.handle,
        avatar_url_session: user.avatar_url,
        followers_count_session: user.followers_count,
        requested_stance: stance,
        normalized_stance: normalized,
      });
    }

    const prevRes = await pool.query(
      "SELECT stance, followers_count FROM community_users WHERE x_user_id = $1 LIMIT 1",
      [user.x_user_id]
    );
    const prevRaw = String(prevRes.rows[0]?.stance ?? "").toLowerCase();
    const prevFollowers = Number(prevRes.rows[0]?.followers_count ?? NaN);
    const prevNormalized =
      prevRaw === "support"
        ? "approve"
        : ["against", "neutral", "approve"].includes(prevRaw)
          ? prevRaw
          : null;

    if (prevNormalized !== normalized) {
      await pool.query(
        `
        INSERT INTO stance_events (x_user_id, from_stance, to_stance)
        VALUES ($1, $2, $3)
      `,
        [user.x_user_id, prevNormalized, normalized]
      );
    }

    const incomingFollowersNum = Number(user.followers_count);
    const safeIncomingFollowers =
      Number.isFinite(incomingFollowersNum) && incomingFollowersNum > 0
        ? incomingFollowersNum
        : null;
    const incomingAvatar = String(user.avatar_url ?? "").trim() || null;
    const incomingName = String(user.name ?? "").trim() || null;

    const result = await pool.query(
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
        stance = EXCLUDED.stance,
        name = COALESCE(NULLIF(EXCLUDED.name, ''), community_users.name),
        followers_count = COALESCE(NULLIF(EXCLUDED.followers_count, 0), community_users.followers_count),
        avatar_url = COALESCE(NULLIF(EXCLUDED.avatar_url, ''), community_users.avatar_url),
        updated_at = NOW()
      RETURNING *
    `,
      [
        user.x_user_id,
        normalizeHandle(user.handle),
        incomingName,
        incomingAvatar,
        safeIncomingFollowers,
        normalized,
      ]
    );

    if (process.env.NODE_ENV !== "production") {
      console.log("[stance-save] persisted-row", {
        x_user_id: result.rows[0]?.x_user_id,
        handle: result.rows[0]?.handle,
        followers_before: Number.isFinite(prevFollowers) ? prevFollowers : null,
        followers_after: result.rows[0]?.followers_count ?? null,
        avatar_url_persisted: result.rows[0]?.avatar_url,
        stance_persisted: result.rows[0]?.stance,
        patch_mode: true,
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

app.get("/api/stats", async (_req, res, next) => {
  try {
    const aggRes = await pool.query(`
      WITH normalized AS (
        SELECT
          CASE
            WHEN lower(coalesce(stance, '')) = 'support' THEN 'approve'
            WHEN lower(coalesce(stance, '')) IN ('against', 'neutral', 'approve') THEN lower(stance)
            ELSE NULL
          END AS stance_norm,
          COALESCE(followers_count, 0) AS followers_count
        FROM community_users
      )
      SELECT
        COUNT(*) FILTER (WHERE stance_norm IS NOT NULL)::int AS total_users_with_stance,
        COUNT(*) FILTER (WHERE stance_norm = 'against')::int AS against_count,
        COUNT(*) FILTER (WHERE stance_norm = 'neutral')::int AS neutral_count,
        COUNT(*) FILTER (WHERE stance_norm = 'approve')::int AS approve_count,
        COALESCE(SUM(followers_count) FILTER (WHERE stance_norm = 'against'), 0)::bigint AS against_followers_total,
        COALESCE(SUM(followers_count) FILTER (WHERE stance_norm = 'neutral'), 0)::bigint AS neutral_followers_total,
        COALESCE(SUM(followers_count) FILTER (WHERE stance_norm = 'approve'), 0)::bigint AS approve_followers_total,
        COALESCE(ROUND(AVG(followers_count) FILTER (WHERE stance_norm = 'against')), 0)::int AS against_followers_avg,
        COALESCE(ROUND(AVG(followers_count) FILTER (WHERE stance_norm = 'neutral')), 0)::int AS neutral_followers_avg,
        COALESCE(ROUND(AVG(followers_count) FILTER (WHERE stance_norm = 'approve')), 0)::int AS approve_followers_avg
      FROM normalized
    `);
    const agg = aggRes.rows[0] || {};
    const toNum = (v: unknown): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

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

    const topRowsRes = await pool.query(`
      WITH ranked AS (
        SELECT
          handle,
          followers_count,
          CASE
            WHEN lower(coalesce(stance, '')) = 'support' THEN 'approve'
            WHEN lower(coalesce(stance, '')) IN ('against', 'neutral', 'approve') THEN lower(stance)
            ELSE NULL
          END AS stance_norm,
          ROW_NUMBER() OVER (
            PARTITION BY
              CASE
                WHEN lower(coalesce(stance, '')) = 'support' THEN 'approve'
                WHEN lower(coalesce(stance, '')) IN ('against', 'neutral', 'approve') THEN lower(stance)
                ELSE NULL
              END
            ORDER BY COALESCE(followers_count, 0) DESC, handle ASC
          ) AS rn
        FROM community_users
      )
      SELECT stance_norm, handle, followers_count
      FROM ranked
      WHERE stance_norm IN ('against', 'neutral', 'approve') AND rn = 1
    `);
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

    const changedEverRes = await pool.query(
      "SELECT COUNT(DISTINCT x_user_id)::int AS changed_ever FROM stance_events"
    );
    const changes7dRes = await pool.query(
      "SELECT COUNT(*)::int AS changes_last_7d FROM stance_events WHERE created_at >= now() - interval '7 days'"
    );
    const flowsRes = await pool.query(`
      WITH norm AS (
        SELECT
          CASE
            WHEN lower(coalesce(from_stance, '')) = 'support' THEN 'approve'
            WHEN lower(coalesce(from_stance, '')) IN ('against', 'neutral', 'approve') THEN lower(from_stance)
            ELSE NULL
          END AS from_norm,
          CASE
            WHEN lower(coalesce(to_stance, '')) = 'support' THEN 'approve'
            WHEN lower(coalesce(to_stance, '')) IN ('against', 'neutral', 'approve') THEN lower(to_stance)
            ELSE NULL
          END AS to_norm
        FROM stance_events
        WHERE created_at >= now() - interval '7 days'
      )
      SELECT from_norm AS "from", to_norm AS "to", COUNT(*)::int AS count
      FROM norm
      WHERE to_norm IN ('against', 'neutral', 'approve')
      GROUP BY from_norm, to_norm
      HAVING COUNT(*) > 0
      ORDER BY count DESC, from_norm NULLS FIRST, to_norm
    `);

    res.json({
      generated_at: new Date().toISOString(),
      total_users_with_stance: totalUsersWithStance,
      counts,
      percentages,
      followers_total: followersTotal,
      followers_avg: followersAvg,
      top_account: topAccount,
      changed_ever: toNum(changedEverRes.rows[0]?.changed_ever),
      changes_last_7d: toNum(changes7dRes.rows[0]?.changes_last_7d),
      flows_last_7d: flowsRes.rows.map((r) => ({
        from: r.from === null ? null : String(r.from),
        to: String(r.to),
        count: toNum(r.count),
      })),
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

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "consensushealth-api",
    time: new Date().toISOString(),
  });
});

if (IS_PROD) {
  if (!fs.existsSync(DIST_PATH)) {
    console.warn(`[ConsensusHealth server] dist folder not found at ${DIST_PATH}. Run: npm run build`);
  } else {
    app.use(express.static(DIST_PATH, { index: false }));
    app.get(/^(?!\/(?:api|auth|dev)(?:\/|$)).*$/, (_req, res) => {
      res.sendFile(path.join(DIST_PATH, "index.html"));
    });
  }
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("UNHANDLED_ERROR:", err);
  res.status(500).json({ error: "Internal server error" });
});

await initDb();
await cleanupExpiredSessions();
logConfig();

app.listen(PORT, () => {
  console.log("ConsensusHealth API running");
  console.log("Using database:", connectionString.replace(/:(?:[^@]*)@/, ":***@"));
  console.log(`ConsensusHealth server listening on http://localhost:${PORT}`);
  if (IS_PROD) {
    console.log(`[ConsensusHealth server] Serving frontend from: ${DIST_PATH}`);
  }
});
