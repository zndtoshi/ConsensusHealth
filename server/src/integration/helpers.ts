/**
 * Shared helpers for Postgres integration tests.
 * Not a test file — excluded from require-integration-passes file list.
 */

import { randomBytes } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { ensureNameTheForkSchema } from "../nameTheFork.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Product / known production hostnames — refused unless URL has test/ci/tmp. */
const KNOWN_PROD_HOST_SUFFIXES = ["consensus.health"];

function hasTestCiTmpMarker(text: string): boolean {
  return /(^|[^a-z0-9])(test|ci|tmp)([^a-z0-9]|$)/i.test(text);
}

function looksProdNamed(text: string): boolean {
  return /(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i.test(text);
}

function isKnownProdHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return false;
  return KNOWN_PROD_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

/**
 * Refuse production / shared-looking database URLs.
 * Allows localhost / 127.0.0.1 / ::1, and URLs that contain test/ci/tmp markers.
 */
export function assertSafeTestDatabaseUrl(url: string): void {
  const raw = String(url ?? "").trim();
  if (!raw) {
    throw new Error("TEST_DATABASE_URL is empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(`TEST_DATABASE_URL must be postgres(ql); got ${parsed.protocol}`);
  }

  const host = (parsed.hostname || "").toLowerCase();
  const dbName = decodeURIComponent((parsed.pathname || "").replace(/^\//, "")).toLowerCase();
  const haystack = `${host}/${dbName}`;

  const isLocal = LOCAL_HOSTS.has(host);
  const hasMarker = hasTestCiTmpMarker(host) || hasTestCiTmpMarker(dbName) || hasTestCiTmpMarker(raw);

  if (isKnownProdHost(host) && !hasMarker) {
    throw new Error(
      `TEST_DATABASE_URL host looks like a shared/production database (${host}); refuse`
    );
  }

  if ((looksProdNamed(host) || looksProdNamed(dbName)) && !hasMarker) {
    throw new Error(
      `TEST_DATABASE_URL looks production-named (${haystack}) without test/ci/tmp; refuse`
    );
  }

  if (!isLocal && !hasMarker) {
    throw new Error(
      "TEST_DATABASE_URL must target localhost/127.0.0.1 or include test/ci/tmp in the URL"
    );
  }
}

export function getRequiredTestDatabaseUrl(): string {
  const url = String(process.env.TEST_DATABASE_URL || "").trim();
  if (!url) {
    throw new Error("TEST_DATABASE_URL is required for integration tests");
  }
  assertSafeTestDatabaseUrl(url);
  return url;
}

export function uniqueTestId(prefix = "it"): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function createTestPool(overrides?: PoolConfig): Pool {
  const connectionString = getRequiredTestDatabaseUrl();
  return new Pool({
    connectionString,
    max: 4,
    ...overrides,
  });
}

export type IsolatedSchema = {
  schema: string;
  pool: Pool;
  /** Drop the isolated schema (CASCADE) and end the pool. */
  cleanup: () => Promise<void>;
};

/**
 * Create a disposable Postgres schema and a pool pinned to it via search_path.
 * Isolates integration rows from other suites (e.g. proposals.migration).
 */
export async function createIsolatedSchemaPool(label = "it"): Promise<IsolatedSchema> {
  const connectionString = getRequiredTestDatabaseUrl();
  const schema = `${label}_${randomBytes(6).toString("hex")}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`refusing unsafe schema name: ${schema}`);
  }

  const admin = new Pool({ connectionString, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    connectionString,
    max: 6,
    options: `-c search_path=${schema}`,
  });

  return {
    schema,
    pool,
    cleanup: async () => {
      try {
        await pool.end();
      } catch {
        // ignore
      }
      const dropper = new Pool({ connectionString, max: 1 });
      try {
        await dropper.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** Minimal tables required by accountDeletion + privacy suppressions flows. */
export async function ensureAccountDeletionSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      x_user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      avatar_path TEXT,
      followers_count INTEGER,
      bio TEXT,
      account_created_at TIMESTAMPTZ,
      stance TEXT CHECK (stance IN ('against','neutral','approve') OR stance IS NULL),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE community_users ADD COLUMN IF NOT EXISTS bio TEXT`);
  await pool.query(
    `ALTER TABLE community_users ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMPTZ`
  );
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stance_history (
      id SERIAL PRIMARY KEY,
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      previous_stance TEXT,
      new_stance TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      changed_by TEXT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      bip_number INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'ongoing'
    );
  `);
  await pool.query(`
    ALTER TABLE proposals ADD COLUMN IF NOT EXISTS admin_only BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    INSERT INTO proposals (id, slug, bip_number, name, status, enabled, admin_only)
    VALUES
      ('bip110', 'bip-110', 110, 'BIP-110', 'final', TRUE, FALSE),
      ('bip54', 'bip-54', 54, 'BIP-54', 'ongoing', TRUE, FALSE)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      enabled = EXCLUDED.enabled,
      admin_only = EXCLUDED.admin_only
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_proposal_stances (
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      stance TEXT NOT NULL CHECK (stance IN ('against','neutral','approve')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (x_user_id, proposal_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_proposal_stance_history (
      id SERIAL PRIMARY KEY,
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      previous_stance TEXT,
      new_stance TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      changed_by TEXT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_proposal_stance_explanations (
      x_user_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      tweet_id TEXT NOT NULL DEFAULT '',
      canonical_url TEXT NOT NULL DEFAULT '',
      tweet_text TEXT NOT NULL DEFAULT '',
      author_handle TEXT NOT NULL DEFAULT '',
      stance_at_verification TEXT NOT NULL DEFAULT 'neutral',
      PRIMARY KEY (x_user_id, proposal_id)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS removed_community_users (
      id SERIAL PRIMARY KEY,
      handle TEXT,
      x_user_id TEXT,
      removed_by TEXT NOT NULL,
      removed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS privacy_suppressions (
      x_user_id TEXT PRIMARY KEY,
      handle_normalized TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Account deletion touches Name the Fork tables; keep fixtures production-compatible.
  await ensureNameTheForkSchema(pool);
}
