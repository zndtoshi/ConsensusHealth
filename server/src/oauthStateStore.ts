/**
 * Postgres-backed OAuth PKCE pending-state store.
 * Atomic consume requires OAuth state + browser nonce + unexpired TTL.
 */

import type { Pool, PoolClient } from "pg";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_STATE_COOKIE = "consensushealth_oauth_state";

export type OAuthPendingMode = "popup" | "redirect";

export type OAuthPendingState = {
  state: string;
  code_verifier: string;
  mode: OAuthPendingMode;
  browser_nonce: string;
  created_at: Date;
  expires_at: Date;
};

type Queryable = Pool | PoolClient;

export async function ensureOAuthStateTable(pool: Queryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_pending_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('popup', 'redirect')),
      browser_nonce TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_oauth_pending_states_expires_at ON oauth_pending_states (expires_at)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_oauth_pending_states_browser_nonce ON oauth_pending_states (browser_nonce)`
  );
}

export async function saveOAuthState(
  pool: Queryable,
  args: {
    state: string;
    code_verifier: string;
    mode?: OAuthPendingMode;
    browser_nonce: string;
    ttlMs?: number;
    now?: Date;
  }
): Promise<OAuthPendingState> {
  const now = args.now ?? new Date();
  const ttl = args.ttlMs ?? OAUTH_STATE_TTL_MS;
  const expires = new Date(now.getTime() + ttl);
  const mode: OAuthPendingMode = args.mode === "popup" ? "popup" : "redirect";
  const result = await pool.query(
    `
    INSERT INTO oauth_pending_states (state, code_verifier, mode, browser_nonce, created_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (state) DO UPDATE SET
      code_verifier = EXCLUDED.code_verifier,
      mode = EXCLUDED.mode,
      browser_nonce = EXCLUDED.browser_nonce,
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at
    RETURNING state, code_verifier, mode, browser_nonce, created_at, expires_at
    `,
    [args.state, args.code_verifier, mode, args.browser_nonce, now, expires]
  );
  return mapRow(result.rows[0]);
}

/**
 * Atomically consume a pending state only when state + browser_nonce match and
 * the row is unexpired. Wrong/missing nonce returns null without deleting the row.
 */
export async function consumeOAuthState(
  pool: Queryable,
  state: string,
  browserNonce: string,
  opts?: { now?: Date }
): Promise<OAuthPendingState | null> {
  const now = opts?.now ?? new Date();
  const stateKey = String(state || "").trim();
  const nonce = String(browserNonce || "").trim();
  if (!stateKey || !nonce) return null;

  const result = await pool.query(
    `
    DELETE FROM oauth_pending_states
    WHERE state = $1
      AND browser_nonce = $2
      AND expires_at > $3
    RETURNING state, code_verifier, mode, browser_nonce, created_at, expires_at
    `,
    [stateKey, nonce, now]
  );
  const row = result.rows[0];
  if (!row) return null;
  return mapRow(row);
}

export async function cleanupExpiredOAuthStates(
  pool: Queryable,
  opts?: { now?: Date }
): Promise<number> {
  const now = opts?.now ?? new Date();
  const result = await pool.query(`DELETE FROM oauth_pending_states WHERE expires_at <= $1`, [now]);
  return result.rowCount ?? 0;
}

function mapRow(row: Record<string, unknown>): OAuthPendingState {
  return {
    state: String(row.state),
    code_verifier: String(row.code_verifier),
    mode: row.mode === "popup" ? "popup" : "redirect",
    browser_nonce: String(row.browser_nonce),
    created_at: new Date(String(row.created_at)),
    expires_at: new Date(String(row.expires_at)),
  };
}

/** SQL fragments exported for unit tests without a live DB. */
export const OAUTH_STATE_SQL = {
  createTable: `CREATE TABLE IF NOT EXISTS oauth_pending_states`,
  consumeReturning: `DELETE FROM oauth_pending_states`,
  consumeBrowserBound: `AND browser_nonce = $2`,
  consumeUnexpired: `AND expires_at > $3`,
  cleanup: `DELETE FROM oauth_pending_states WHERE expires_at`,
} as const;
