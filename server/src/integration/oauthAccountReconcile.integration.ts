/**
 * Real Postgres: OAuth community_users reconcile without a legacy numeric `id`.
 * Covers production explanation columns, collision merge, privacy/moderation
 * immutability, nullable legacy handle rows, and transactional rollback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  assertSafeTestDatabaseUrl,
  createIsolatedSchemaPool,
  getRequiredTestDatabaseUrl,
} from "./helpers.js";
import { reconcileOauthCommunityUser } from "../oauthAccountReconcile.js";

const TEST_DATABASE_URL = getRequiredTestDatabaseUrl();
assertSafeTestDatabaseUrl(TEST_DATABASE_URL);

async function assertNoCommunityUsersId(pool: Pool): Promise<void> {
  const idCol = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'community_users'
       AND column_name = 'id'`
  );
  assert.equal(idCol.rowCount, 0, "fixture must not have community_users.id");
}

/** Canonical x_user_id PK schema + production-shaped explanation constraints. */
async function ensureCanonicalSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE community_users (
      x_user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      followers_count INTEGER,
      bio TEXT,
      account_created_at TIMESTAMPTZ,
      stance TEXT CHECK (stance IN ('against','neutral','approve') OR stance IS NULL),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE proposals (
      id TEXT PRIMARY KEY
    );
  `);
  await pool.query(`INSERT INTO proposals (id) VALUES ('bip54'), ('bip448')`);
  await pool.query(`
    CREATE TABLE user_proposal_stances (
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      stance TEXT NOT NULL CHECK (stance IN ('against','neutral','approve')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (x_user_id, proposal_id)
    );
  `);
  await pool.query(`
    CREATE TABLE user_proposal_stance_history (
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
    CREATE TABLE user_proposal_stance_explanations (
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      tweet_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      tweet_text TEXT NOT NULL,
      author_x_user_id TEXT NULL,
      author_handle TEXT NOT NULL,
      stance_at_verification TEXT NOT NULL
        CHECK (stance_at_verification IN ('against','neutral','approve')),
      verification_method TEXT NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      unavailable_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (x_user_id, proposal_id),
      CONSTRAINT user_proposal_stance_explanations_stance_fk
        FOREIGN KEY (x_user_id, proposal_id)
        REFERENCES user_proposal_stances (x_user_id, proposal_id)
        ON DELETE CASCADE,
      CONSTRAINT stance_explanations_verification_coherence CHECK (
        verification_method IS NULL
        OR (
          verification_method = 'x_api_author_id'
          AND author_x_user_id IS NOT NULL
          AND btrim(author_x_user_id) <> ''
        )
        OR (
          verification_method = 'x_oembed_author_handle'
          AND author_x_user_id IS NULL
        )
      )
    );
  `);
  await pool.query(`
    CREATE TABLE privacy_suppressions (
      x_user_id TEXT PRIMARY KEY,
      handle_normalized TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE removed_community_users (
      id SERIAL PRIMARY KEY,
      handle TEXT,
      x_user_id TEXT,
      removed_by TEXT NOT NULL,
      removed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Legacy schema: nullable x_user_id (UNIQUE), no numeric id. */
async function ensureLegacyNullableXUserIdSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE community_users (
      x_user_id TEXT UNIQUE,
      handle TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      followers_count INTEGER,
      bio TEXT,
      account_created_at TIMESTAMPTZ,
      stance TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

test("integration: link distinct stable id + collision merge preserves explanation provenance", async () => {
  const iso = await createIsolatedSchemaPool("oauth_reconcile");
  try {
    await ensureCanonicalSchema(iso.pool);
    await assertNoCommunityUsersId(iso.pool);

    // Distinct stable-ID row (not "handle-only") with bip54 against + coherent explanation.
    await iso.pool.query(
      `INSERT INTO community_users (x_user_id, handle, name, stance)
       VALUES ('seed-x', 'alice', 'Seed Alice', 'against')`
    );
    await iso.pool.query(
      `INSERT INTO sessions (session_id, x_user_id, expires_at)
       VALUES ('sess-seed', 'seed-x', now() + interval '1 day')`
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance, updated_at)
       VALUES ('seed-x', 'bip54', 'against', '2023-01-01T00:00:00.000Z')`
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stance_explanations (
         x_user_id, proposal_id, tweet_id, canonical_url, tweet_text,
         author_x_user_id, author_handle, stance_at_verification,
         verification_method, verified_at, unavailable_at, created_at, updated_at
       ) VALUES (
         'seed-x', 'bip54', '111', 'https://x.com/alice/status/111', 'seed text',
         '999', 'alice', 'against',
         'x_api_author_id', '2023-01-02T00:00:00.000Z', NULL,
         '2023-01-01T00:00:00.000Z', '2023-01-02T00:00:00.000Z'
       )`
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stance_history (x_user_id, proposal_id, previous_stance, new_stance, changed_by)
       VALUES ('seed-x', 'bip54', NULL, 'against', 'user')`
    );
    await iso.pool.query(
      `INSERT INTO privacy_suppressions (x_user_id, handle_normalized)
       VALUES ('tombstone-1', 'goneuser')`
    );
    await iso.pool.query(
      `INSERT INTO removed_community_users (handle, x_user_id, removed_by)
       VALUES ('modded', 'mod-x', 'admin')`
    );

    const client = await iso.pool.connect();
    try {
      await client.query("BEGIN");
      await reconcileOauthCommunityUser(client, {
        xUserId: "oauth-1",
        handle: "alice",
        name: "OAuth Alice",
        avatarUrl: "https://example.com/a.jpg",
        followersCount: 12,
        bio: "bio",
        accountCreatedAt: "2020-01-01T00:00:00.000Z",
      });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const afterLink = await iso.pool.query(`SELECT * FROM community_users`);
    assert.equal(afterLink.rowCount, 1);
    assert.equal(afterLink.rows[0].x_user_id, "oauth-1");
    assert.equal(afterLink.rows[0].handle, "alice");
    assert.equal(afterLink.rows[0].stance, "against");

    const linkedExp = await iso.pool.query(
      `SELECT * FROM user_proposal_stance_explanations WHERE x_user_id = 'oauth-1' AND proposal_id = 'bip54'`
    );
    assert.equal(linkedExp.rowCount, 1);
    assert.equal(linkedExp.rows[0].author_x_user_id, "999");
    assert.equal(linkedExp.rows[0].verification_method, "x_api_author_id");
    assert.equal(linkedExp.rows[0].tweet_id, "111");
    assert.equal(String(linkedExp.rows[0].verified_at.toISOString()), "2023-01-02T00:00:00.000Z");

    // Privacy / moderation records untouched.
    const privacy = await iso.pool.query(`SELECT * FROM privacy_suppressions ORDER BY x_user_id`);
    assert.equal(privacy.rowCount, 1);
    assert.equal(privacy.rows[0].x_user_id, "tombstone-1");
    const removed = await iso.pool.query(`SELECT handle, x_user_id, removed_by FROM removed_community_users`);
    assert.equal(removed.rowCount, 1);
    assert.equal(removed.rows[0].x_user_id, "mod-x");

    // Collision: oauth-2 already has bip54 neutral (newer) + incoherent-vs-winner explanation;
    // seed/oauth-1 has against (older). Winner stance = neutral (newer). Keep oauth-2 explanation.
    await iso.pool.query(
      `INSERT INTO community_users (x_user_id, handle, name, stance)
       VALUES ('oauth-2', 'bob', 'Bob', NULL)`
    );
    await iso.pool.query(
      `INSERT INTO sessions (session_id, x_user_id, expires_at)
       VALUES ('sess-oauth2', 'oauth-2', now() + interval '1 day')`
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance, updated_at)
       VALUES ('oauth-2', 'bip54', 'neutral', '2024-06-01T00:00:00.000Z')`
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stance_explanations (
         x_user_id, proposal_id, tweet_id, canonical_url, tweet_text,
         author_x_user_id, author_handle, stance_at_verification,
         verification_method, verified_at, created_at, updated_at
       ) VALUES (
         'oauth-2', 'bip54', '222', 'https://x.com/bob/status/222', 'bob text',
         NULL, 'bob', 'neutral',
         'x_oembed_author_handle', '2024-06-02T00:00:00.000Z',
         '2024-06-01T00:00:00.000Z', '2024-06-02T00:00:00.000Z'
       )`
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stance_history (x_user_id, proposal_id, previous_stance, new_stance, changed_by)
       VALUES ('oauth-2', 'bip54', NULL, 'neutral', 'user')`
    );

    const client2 = await iso.pool.connect();
    try {
      await client2.query("BEGIN");
      await reconcileOauthCommunityUser(client2, {
        xUserId: "oauth-1",
        handle: "alice",
        name: "OAuth Alice 2",
        avatarUrl: null,
        followersCount: 20,
        bio: null,
        accountCreatedAt: null,
      });
      await reconcileOauthCommunityUser(client2, {
        xUserId: "oauth-2",
        handle: "alice",
        name: "Merged",
        avatarUrl: null,
        followersCount: 3,
        bio: null,
        accountCreatedAt: null,
      });
      await client2.query("COMMIT");
    } catch (e) {
      await client2.query("ROLLBACK");
      throw e;
    } finally {
      client2.release();
    }

    const finalUsers = await iso.pool.query(`SELECT x_user_id, handle, name FROM community_users`);
    assert.equal(finalUsers.rowCount, 1);
    assert.equal(finalUsers.rows[0].x_user_id, "oauth-2");
    assert.equal(finalUsers.rows[0].handle, "alice");

    const finalStance = await iso.pool.query(
      `SELECT stance, updated_at FROM user_proposal_stances WHERE x_user_id = 'oauth-2' AND proposal_id = 'bip54'`
    );
    assert.equal(finalStance.rowCount, 1);
    assert.equal(finalStance.rows[0].stance, "neutral");

    const finalExp = await iso.pool.query(
      `SELECT * FROM user_proposal_stance_explanations WHERE x_user_id = 'oauth-2' AND proposal_id = 'bip54'`
    );
    assert.equal(finalExp.rowCount, 1);
    assert.equal(finalExp.rows[0].stance_at_verification, "neutral");
    assert.equal(finalExp.rows[0].tweet_id, "222");
    assert.equal(finalExp.rows[0].verification_method, "x_oembed_author_handle");
    assert.equal(finalExp.rows[0].author_x_user_id, null);
    assert.equal(String(finalExp.rows[0].verified_at.toISOString()), "2024-06-02T00:00:00.000Z");

    const history = await iso.pool.query(
      `SELECT x_user_id, new_stance FROM user_proposal_stance_history WHERE proposal_id = 'bip54' ORDER BY id`
    );
    assert.equal(history.rowCount, 2);
    assert.ok(history.rows.every((r) => r.x_user_id === "oauth-2"));
    assert.deepEqual(
      history.rows.map((r) => r.new_stance).sort(),
      ["against", "neutral"]
    );

    const sessions = await iso.pool.query(`SELECT session_id, x_user_id FROM sessions ORDER BY session_id`);
    assert.equal(sessions.rowCount, 2);
    assert.ok(sessions.rows.every((r) => r.x_user_id === "oauth-2"));

    // Tombstones still intact and unreassigned.
    const privacyAfter = await iso.pool.query(`SELECT x_user_id, handle_normalized FROM privacy_suppressions`);
    assert.deepEqual(privacyAfter.rows, [{ x_user_id: "tombstone-1", handle_normalized: "goneuser" }]);
    const removedAfter = await iso.pool.query(
      `SELECT handle, x_user_id, removed_by FROM removed_community_users`
    );
    assert.deepEqual(removedAfter.rows, [{ handle: "modded", x_user_id: "mod-x", removed_by: "admin" }]);
  } finally {
    await iso.cleanup();
  }
});

test("integration: existing x_user_id login updates profile in place", async () => {
  const iso = await createIsolatedSchemaPool("oauth_existing");
  try {
    await ensureCanonicalSchema(iso.pool);
    await iso.pool.query(
      `INSERT INTO community_users (x_user_id, handle, name, stance)
       VALUES ('oauth-keep', 'carol', 'Carol', 'approve')`
    );
    const client = await iso.pool.connect();
    try {
      await client.query("BEGIN");
      await reconcileOauthCommunityUser(client, {
        xUserId: "oauth-keep",
        handle: "carol",
        name: "Carol Updated",
        avatarUrl: "https://example.com/c.jpg",
        followersCount: 9,
        bio: "hi",
        accountCreatedAt: null,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const row = await iso.pool.query(`SELECT * FROM community_users WHERE x_user_id = 'oauth-keep'`);
    assert.equal(row.rows[0].name, "Carol Updated");
    assert.equal(row.rows[0].stance, "approve");
    assert.equal(row.rows[0].followers_count, 9);
  } finally {
    await iso.cleanup();
  }
});

test("integration: brand-new oauth user inserts a row", async () => {
  const iso = await createIsolatedSchemaPool("oauth_new");
  try {
    await ensureCanonicalSchema(iso.pool);
    const client = await iso.pool.connect();
    try {
      await client.query("BEGIN");
      await reconcileOauthCommunityUser(client, {
        xUserId: "brand-new",
        handle: "newbie",
        name: "New",
        avatarUrl: null,
        followersCount: null,
        bio: null,
        accountCreatedAt: null,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const rows = await iso.pool.query(`SELECT x_user_id, handle, stance FROM community_users`);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].x_user_id, "brand-new");
    assert.equal(rows.rows[0].handle, "newbie");
    assert.equal(rows.rows[0].stance, null);
  } finally {
    await iso.cleanup();
  }
});

test("integration: nullable legacy handle-only row links to oauth x_user_id", async () => {
  const iso = await createIsolatedSchemaPool("oauth_legacy_null");
  try {
    await ensureLegacyNullableXUserIdSchema(iso.pool);
    await assertNoCommunityUsersId(iso.pool);
    await iso.pool.query(
      `INSERT INTO community_users (x_user_id, handle, name, stance)
       VALUES (NULL, 'legacyhandle', 'Legacy', 'neutral')`
    );
    const client = await iso.pool.connect();
    try {
      await client.query("BEGIN");
      await reconcileOauthCommunityUser(client, {
        xUserId: "oauth-legacy",
        handle: "legacyhandle",
        name: "Linked",
        avatarUrl: null,
        followersCount: 1,
        bio: null,
        accountCreatedAt: null,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const rows = await iso.pool.query(`SELECT x_user_id, handle, name, stance FROM community_users`);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].x_user_id, "oauth-legacy");
    assert.equal(rows.rows[0].handle, "legacyhandle");
    assert.equal(rows.rows[0].stance, "neutral");
    assert.equal(rows.rows[0].name, "Linked");
  } finally {
    await iso.cleanup();
  }
});

test("integration: dependent-write failure rolls back the whole reconcile transaction", async () => {
  const iso = await createIsolatedSchemaPool("oauth_rollback");
  try {
    await ensureCanonicalSchema(iso.pool);
    await iso.pool.query(
      `INSERT INTO community_users (x_user_id, handle, name, stance)
       VALUES ('seed-r', 'rollback', 'Seed', 'against')`
    );
    await iso.pool.query(
      `INSERT INTO sessions (session_id, x_user_id, expires_at)
       VALUES ('sess-r', 'seed-r', now() + interval '1 day')`
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance)
       VALUES ('seed-r', 'bip54', 'against')`
    );

    // Fail any session reassignment so reconcile cannot complete.
    await iso.pool.query(`
      CREATE OR REPLACE FUNCTION ch_fail_session_reassign() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected session reassign failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await iso.pool.query(`
      CREATE TRIGGER trg_fail_session_reassign
      BEFORE UPDATE OF x_user_id ON sessions
      FOR EACH ROW EXECUTE PROCEDURE ch_fail_session_reassign();
    `);

    const client = await iso.pool.connect();
    let failed = false;
    try {
      await client.query("BEGIN");
      await reconcileOauthCommunityUser(client, {
        xUserId: "oauth-r",
        handle: "rollback",
        name: "Should Not Commit",
        avatarUrl: null,
        followersCount: null,
        bio: null,
        accountCreatedAt: null,
      });
      await client.query("COMMIT");
    } catch {
      failed = true;
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    assert.equal(failed, true);

    const users = await iso.pool.query(`SELECT x_user_id, handle, name FROM community_users`);
    assert.equal(users.rowCount, 1);
    assert.equal(users.rows[0].x_user_id, "seed-r");
    assert.equal(users.rows[0].name, "Seed");
    const sess = await iso.pool.query(`SELECT x_user_id FROM sessions`);
    assert.equal(sess.rows[0].x_user_id, "seed-r");
    const stances = await iso.pool.query(`SELECT x_user_id FROM user_proposal_stances`);
    assert.equal(stances.rows[0].x_user_id, "seed-r");
  } finally {
    await iso.cleanup();
  }
});
