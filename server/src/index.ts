import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const PORT = Number(process.env.PORT || 8787);
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const DATABASE_URL = process.env.DATABASE_URL || "";
const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID || "";
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET || "";
const TWITTER_REDIRECT_URI = process.env.TWITTER_REDIRECT_URI || "http://localhost:8787/auth/x/callback";
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({ connectionString: DATABASE_URL });

const app = express();
app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

type PendingAuth = {
  verifier: string;
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
      x_user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      followers_count INTEGER,
      stance TEXT CHECK (stance IN ('against','neutral','support')),
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

async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const sid = req.cookies?.consensushealth_session as string | undefined;
  if (!sid) return null;
  const { rows } = await pool.query<SessionUser>(
    `
      SELECT cu.x_user_id, cu.handle, cu.name, cu.avatar_url, cu.followers_count, cu.stance
      FROM sessions s
      JOIN community_users cu ON cu.x_user_id = s.x_user_id
      WHERE s.session_id = $1
        AND s.expires_at > now()
      LIMIT 1
    `,
    [sid]
  );
  return rows[0] ?? null;
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    (req as Request & { user: SessionUser }).user = user;
    next();
  } catch (err) {
    next(err);
  }
}

app.get("/auth/x", async (_req, res) => {
  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    res.status(500).json({ error: "Twitter OAuth env vars are missing" });
    return;
  }
  const state = uuidv4();
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  pendingAuth.set(state, { verifier, createdAt: Date.now() });

  const url = new URL("https://twitter.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", TWITTER_CLIENT_ID);
  url.searchParams.set("redirect_uri", TWITTER_REDIRECT_URI);
  url.searchParams.set("scope", "users.read follows.read tweet.read");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  res.redirect(url.toString());
});

app.get("/auth/x/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state) {
      res.status(400).send("Missing OAuth code/state");
      return;
    }
    const pending = pendingAuth.get(state);
    pendingAuth.delete(state);
    if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      res.status(400).send("Invalid or expired OAuth state");
      return;
    }

    const tokenBody = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: TWITTER_CLIENT_ID,
      redirect_uri: TWITTER_REDIRECT_URI,
      code_verifier: pending.verifier,
    });

    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: getBearerTokenBasicAuthHeader(TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET),
      },
      body: tokenBody,
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      res.status(502).send(`OAuth token exchange failed: ${txt}`);
      return;
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      res.status(502).send("OAuth token missing access_token");
      return;
    }

    const meRes = await fetch(
      "https://api.twitter.com/2/users/me?user.fields=profile_image_url,public_metrics",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!meRes.ok) {
      const txt = await meRes.text();
      res.status(502).send(`Twitter profile fetch failed: ${txt}`);
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
      res.status(502).send("Twitter profile response missing required fields");
      return;
    }

    const xUserId = String(data.id);
    const handle = String(data.username).toLowerCase();
    const name = data.name ? String(data.name) : null;
    const avatarUrl = data.profile_image_url ? String(data.profile_image_url).replace("_normal", "") : null;
    const followersCount =
      typeof data.public_metrics?.followers_count === "number" ? data.public_metrics.followers_count : null;

    await pool.query(
      `
      INSERT INTO community_users (x_user_id, handle, name, avatar_url, followers_count, updated_at)
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT (x_user_id) DO UPDATE
      SET handle = EXCLUDED.handle,
          name = EXCLUDED.name,
          avatar_url = EXCLUDED.avatar_url,
          followers_count = EXCLUDED.followers_count,
          updated_at = now()
    `,
      [xUserId, handle, name, avatarUrl, followersCount]
    );

    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await pool.query(
      `
      INSERT INTO sessions (session_id, x_user_id, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id) DO UPDATE
      SET x_user_id = EXCLUDED.x_user_id,
          expires_at = EXCLUDED.expires_at
    `,
      [sessionId, xUserId, expiresAt.toISOString()]
    );

    res.cookie("consensushealth_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      expires: expiresAt,
    });
    res.redirect(CLIENT_URL);
  } catch (err) {
    next(err);
  }
});

app.get("/api/community", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT x_user_id, handle, name, avatar_url, followers_count, stance, updated_at
      FROM community_users
      ORDER BY updated_at DESC
    `
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get("/api/me", async (req, res, next) => {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      res.json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, ...user });
  } catch (err) {
    next(err);
  }
});

app.post("/api/stance", requireAuth, async (req, res, next) => {
  try {
    const stance = String(req.body?.stance || "").toLowerCase();
    if (!["against", "neutral", "support"].includes(stance)) {
      res.status(400).json({ error: "Invalid stance" });
      return;
    }
    const user = (req as Request & { user: SessionUser }).user;
    await pool.query(
      `
      INSERT INTO community_users (x_user_id, handle, name, avatar_url, followers_count, stance, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (x_user_id) DO UPDATE
      SET handle = EXCLUDED.handle,
          name = EXCLUDED.name,
          avatar_url = EXCLUDED.avatar_url,
          followers_count = EXCLUDED.followers_count,
          stance = EXCLUDED.stance,
          updated_at = now()
    `,
      [user.x_user_id, user.handle, user.name, user.avatar_url, user.followers_count, stance]
    );
    const { rows } = await pool.query(
      `
      SELECT x_user_id, handle, name, avatar_url, followers_count, stance, updated_at
      FROM community_users
      WHERE x_user_id = $1
      LIMIT 1
    `,
      [user.x_user_id]
    );
    res.json(rows[0] ?? null);
  } catch (err) {
    next(err);
  }
});

app.post("/auth/logout", async (req, res, next) => {
  try {
    const sid = req.cookies?.consensushealth_session as string | undefined;
    if (sid) {
      await pool.query(`DELETE FROM sessions WHERE session_id = $1`, [sid]);
    }
    res.clearCookie("consensushealth_session", { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

await initDb();
await cleanupExpiredSessions();

app.listen(PORT, () => {
  console.log(`ConsensusHealth server listening on http://localhost:${PORT}`);
});
