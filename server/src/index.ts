import crypto from "node:crypto";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });

const PORT = Number(process.env.PORT || 8787);
const CLIENT_URL = process.env.APP_ORIGIN || process.env.CLIENT_URL || "http://localhost:5173";
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const TWITTER_CLIENT_ID = process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID || "";
const TWITTER_CLIENT_SECRET = process.env.X_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET || "";
const TWITTER_REDIRECT_URI =
  process.env.X_REDIRECT_URI ||
  process.env.TWITTER_REDIRECT_URI ||
  "http://localhost:8787/auth/x/callback";
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

const app = express();
app.use(
  cors({
    origin: process.env.APP_ORIGIN || "http://localhost:5173",
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

app.get("/auth/x", async (_req, res) => {
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
    secure: false,
    path: "/",
    maxAge: 10 * 60 * 1000,
  });

  const url = new URL("https://x.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", TWITTER_CLIENT_ID);
  url.searchParams.set("redirect_uri", TWITTER_REDIRECT_URI);
  url.searchParams.set("scope", "users.read tweet.read");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  res.redirect(url.toString());
});

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

    const tokenBody = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: TWITTER_REDIRECT_URI,
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
    const avatarUrl = data.profile_image_url ? String(data.profile_image_url).replace("_normal", "") : null;
    const followersCount =
      typeof data.public_metrics?.followers_count === "number" ? data.public_metrics.followers_count : null;

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
      secure: false,
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      signed: true,
    });
    res.redirect(CLIENT_URL);
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
    const normalized = stance === "support" ? "support" : stance;

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
        followers_count = EXCLUDED.followers_count,
        avatar_url = EXCLUDED.avatar_url,
        updated_at = NOW()
      RETURNING *
    `,
      [
        user.x_user_id,
        user.handle,
        user.name,
        user.avatar_url,
        user.followers_count,
        normalized,
      ]
    );

    res.json(result.rows[0]);
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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("UNHANDLED_ERROR:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "consensushealth-api",
    time: new Date().toISOString(),
  });
});

await initDb();
await cleanupExpiredSessions();

app.listen(PORT, () => {
  console.log("ConsensusHealth API running");
  console.log("Using database:", connectionString.replace(/:(?:[^@]*)@/, ":***@"));
  console.log(`ConsensusHealth server listening on http://localhost:${PORT}`);
});
