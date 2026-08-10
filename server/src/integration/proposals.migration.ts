/**
 * Database integration tests for Consensus Universe migrations.
 * Requires TEST_DATABASE_URL. Skips cleanly when unset.
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:integration
 *
 * Do not point at production or shared development data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  CONSENSUS_UNIVERSE_MIGRATION_VERSION,
  ensureProposalSchema,
} from "../proposals.js";

const TEST_DATABASE_URL = (process.env.TEST_DATABASE_URL || "").trim();

function requirePool(): Pool | null {
  if (!TEST_DATABASE_URL) return null;
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
}

async function resetUniverseTables(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS user_proposal_stance_history CASCADE;
    DROP TABLE IF EXISTS user_proposal_stances CASCADE;
    DROP TABLE IF EXISTS proposals CASCADE;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`DELETE FROM schema_migrations WHERE version = $1`, [
    CONSENSUS_UNIVERSE_MIGRATION_VERSION,
  ]);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_users (
      x_user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      followers_count INTEGER,
      stance TEXT CHECK (stance IN ('against','neutral','approve') OR stance IS NULL),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`TRUNCATE community_users CASCADE`).catch(() => undefined);
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
  await pool.query(`TRUNCATE stance_history RESTART IDENTITY CASCADE`).catch(() => undefined);
}

test("integration: ensureProposalSchema is idempotent and records version", async (t) => {
  const pool = requirePool();
  if (!pool) {
    t.skip("TEST_DATABASE_URL not set");
    return;
  }
  try {
    await resetUniverseTables(pool);
    await pool.query(
      `INSERT INTO community_users (x_user_id, handle, stance) VALUES ('u1','alice','against')
       ON CONFLICT (x_user_id) DO UPDATE SET stance = EXCLUDED.stance`
    );
    await pool.query(
      `INSERT INTO stance_history (x_user_id, previous_stance, new_stance, changed_by)
       VALUES ('u1', NULL, 'against', 'user'), ('u1', 'against', 'support', 'user')`
    );

    await ensureProposalSchema(pool);
    await ensureProposalSchema(pool);

    const versions = await pool.query(
      `SELECT version FROM schema_migrations WHERE version = $1`,
      [CONSENSUS_UNIVERSE_MIGRATION_VERSION]
    );
    assert.equal(versions.rowCount, 1);

    const stances = await pool.query(
      `SELECT * FROM user_proposal_stances WHERE proposal_id = 'bip110'`
    );
    assert.ok((stances.rowCount ?? 0) >= 1);

    const hist = await pool.query(
      `SELECT legacy_stance_history_id FROM user_proposal_stance_history WHERE proposal_id = 'bip110'`
    );
    assert.ok((hist.rowCount ?? 0) >= 1);
    assert.ok(hist.rows.every((r) => r.legacy_stance_history_id != null));
    const normalizedHistory = await pool.query(
      `SELECT previous_stance, new_stance
       FROM user_proposal_stance_history
       WHERE proposal_id = 'bip110' AND x_user_id = 'u1'
       ORDER BY legacy_stance_history_id`
    );
    assert.deepEqual(
      normalizedHistory.rows.map((r) => [r.previous_stance, r.new_stance]),
      [
        [null, "against"],
        ["against", "approve"],
      ]
    );

    const hist2count = await pool.query(
      `SELECT COUNT(*)::int AS c FROM user_proposal_stance_history WHERE proposal_id = 'bip110'`
    );
    await ensureProposalSchema(pool);
    const hist2countAfter = await pool.query(
      `SELECT COUNT(*)::int AS c FROM user_proposal_stance_history WHERE proposal_id = 'bip110'`
    );
    assert.equal(hist2count.rows[0].c, hist2countAfter.rows[0].c);

    // Do not overwrite newer canonical stance with older legacy.
    await pool.query(
      `UPDATE user_proposal_stances SET stance = 'approve' WHERE x_user_id = 'u1' AND proposal_id = 'bip110'`
    );
    await pool.query(`UPDATE community_users SET stance = 'against' WHERE x_user_id = 'u1'`);
    await ensureProposalSchema(pool);
    const after = await pool.query(
      `SELECT stance FROM user_proposal_stances WHERE x_user_id = 'u1' AND proposal_id = 'bip110'`
    );
    assert.equal(after.rows[0].stance, "approve");
  } finally {
    await pool.end();
  }
});

test("integration: concurrent migrations do not duplicate history", async (t) => {
  const pool = requirePool();
  if (!pool) {
    t.skip("TEST_DATABASE_URL not set");
    return;
  }
  try {
    await resetUniverseTables(pool);
    await pool.query(
      `INSERT INTO community_users (x_user_id, handle, stance) VALUES ('u3','cara','neutral')`
    );
    await pool.query(
      `INSERT INTO stance_history (x_user_id, previous_stance, new_stance, changed_by)
       VALUES ('u3', NULL, 'neutral', 'user'), ('u3', 'neutral', 'against', 'user')`
    );
    await Promise.all([ensureProposalSchema(pool), ensureProposalSchema(pool), ensureProposalSchema(pool)]);
    const hist = await pool.query(
      `SELECT COUNT(*)::int AS c FROM user_proposal_stance_history WHERE proposal_id = 'bip110' AND x_user_id = 'u3'`
    );
    assert.equal(hist.rows[0].c, 2);
    const stances = await pool.query(
      `SELECT COUNT(*)::int AS c FROM user_proposal_stances WHERE proposal_id = 'bip110' AND x_user_id = 'u3'`
    );
    assert.equal(stances.rows[0].c, 1);
  } finally {
    await pool.end();
  }
});

test("integration: independent proposal stances + first-position scoping", async (t) => {
  const pool = requirePool();
  if (!pool) {
    t.skip("TEST_DATABASE_URL not set");
    return;
  }
  try {
    await resetUniverseTables(pool);
    await ensureProposalSchema(pool);
    await pool.query(
      `INSERT INTO community_users (x_user_id, handle, stance) VALUES ('u2','bob',NULL)
       ON CONFLICT (x_user_id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance)
       VALUES ('u2','bip110','against'), ('u2','bip54','approve')
       ON CONFLICT (x_user_id, proposal_id) DO UPDATE SET stance = EXCLUDED.stance`
    );
    const r = await pool.query(
      `SELECT proposal_id, stance FROM user_proposal_stances WHERE x_user_id = 'u2' ORDER BY proposal_id`
    );
    assert.deepEqual(
      r.rows.map((x) => [x.proposal_id, x.stance]),
      [
        ["bip110", "against"],
        ["bip54", "approve"],
      ]
    );
    const bip448 = await pool.query(
      `SELECT 1 FROM user_proposal_stances WHERE proposal_id = 'bip448'`
    );
    assert.equal(bip448.rowCount, 0);

    // Genuine repeated transitions at different times are preserved.
    await pool.query(
      `INSERT INTO user_proposal_stance_history
         (x_user_id, proposal_id, previous_stance, new_stance, changed_at, changed_by)
       VALUES
         ('u2','bip54','approve','neutral', now() - interval '1 hour', 'user'),
         ('u2','bip54','neutral','approve', now(), 'user')`
    );
    const histCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM user_proposal_stance_history WHERE x_user_id = 'u2' AND proposal_id = 'bip54'`
    );
    assert.equal(histCount.rows[0].c, 2);
  } finally {
    await pool.end();
  }
});

test("integration: legacy-only edits do not change canonical stances", async (t) => {
  const pool = requirePool();
  if (!pool) {
    t.skip("TEST_DATABASE_URL not set");
    return;
  }
  try {
    await resetUniverseTables(pool);
    await pool.query(
      `INSERT INTO community_users (x_user_id, handle, stance) VALUES ('u4','dana','against')`
    );
    await ensureProposalSchema(pool);
    await pool.query(`UPDATE community_users SET stance = 'approve' WHERE x_user_id = 'u4'`);
    const canon = await pool.query(
      `SELECT stance FROM user_proposal_stances WHERE x_user_id = 'u4' AND proposal_id = 'bip110'`
    );
    assert.equal(canon.rows[0].stance, "against");
  } finally {
    await pool.end();
  }
});
