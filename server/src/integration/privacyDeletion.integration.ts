/**
 * Real Postgres integration tests for privacy suppressions + account deletion.
 * Requires TEST_DATABASE_URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { deleteAuthenticatedAccount } from "../accountDeletion.js";
import {
  ensurePrivacySuppressionsTable,
  filterPrivacySuppressedAccounts,
  loadPrivacySuppressionKeys,
  upsertPrivacySuppression,
} from "../privacySuppressions.js";
import {
  assertSafeTestDatabaseUrl,
  createIsolatedSchemaPool,
  ensureAccountDeletionSchema,
  getRequiredTestDatabaseUrl,
  uniqueTestId,
} from "./helpers.js";

const TEST_DATABASE_URL = getRequiredTestDatabaseUrl();
assertSafeTestDatabaseUrl(TEST_DATABASE_URL);

async function seedUser(
  pool: Pool,
  user: { x_user_id: string; handle: string; bip110Stance?: string }
) {
  await pool.query(
    `INSERT INTO community_users (x_user_id, handle, stance, avatar_path)
     VALUES ($1, $2, $3, $4)`,
    [user.x_user_id, user.handle, user.bip110Stance ?? "against", `/avatars/${user.x_user_id}.jpg`]
  );
  await pool.query(
    `INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance)
     VALUES ($1, 'bip110', $2)`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO user_proposal_stance_history (x_user_id, proposal_id, previous_stance, new_stance, changed_by)
     VALUES ($1, 'bip110', NULL, $2, 'user')`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO stance_history (x_user_id, previous_stance, new_stance, changed_by)
     VALUES ($1, NULL, $2, 'user')`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO stance_events (x_user_id, from_stance, to_stance)
     VALUES ($1, NULL, $2)`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO sessions (session_id, x_user_id, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [`sess_${user.x_user_id}`, user.x_user_id]
  );
  await pool.query(
    `INSERT INTO removed_community_users (handle, x_user_id, removed_by)
     VALUES ($1, $2, 'admin')`,
    [user.handle, user.x_user_id]
  );
}

test("integration: privacy schema idempotency + BIP110 tombstone + re-login DB stances", async () => {
  const iso = await createIsolatedSchemaPool("privdel");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensurePrivacySuppressionsTable(iso.pool);
    await ensurePrivacySuppressionsTable(iso.pool);

    const xUserId = uniqueTestId("bip110_user");
    const handle = `seed_${xUserId.slice(-8)}`;
    await seedUser(iso.pool, { x_user_id: xUserId, handle, bip110Stance: "against" });

    const deleted = await deleteAuthenticatedAccount({
      pool: iso.pool,
      sessionUser: { x_user_id: xUserId, handle },
      avatarsDir: "/tmp/avatars-integration",
      unlink: async () => {},
    });
    assert.equal(deleted.deleted, true);

    const userGone = await iso.pool.query(
      `SELECT 1 FROM community_users WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(userGone.rowCount, 0);

    const stancesGone = await iso.pool.query(
      `SELECT 1 FROM user_proposal_stances WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(stancesGone.rowCount, 0);

    const tombstone = await iso.pool.query(
      `SELECT handle_normalized FROM privacy_suppressions WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(tombstone.rowCount, 1);
    assert.equal(tombstone.rows[0].handle_normalized, handle.toLowerCase());

    // Curated BIP110 seed identity must not return via privacy filter.
    const keys = await loadPrivacySuppressionKeys(iso.pool);
    const curatedSeed = [
      { x_user_id: xUserId, handle, stance: "against", source: "seed" },
      { x_user_id: uniqueTestId("other_seed"), handle: "other_seed_ok", stance: "approve" },
    ];
    const visibleSeed = filterPrivacySuppressedAccounts(curatedSeed, keys);
    assert.equal(visibleSeed.length, 1);
    assert.equal(visibleSeed[0].handle, "other_seed_ok");
    assert.ok(!visibleSeed.some((a) => a.x_user_id === xUserId));

    // Already-deleted: idempotent tombstone, not_found.
    const again = await deleteAuthenticatedAccount({
      pool: iso.pool,
      sessionUser: { x_user_id: xUserId, handle },
      avatarsDir: "/tmp/avatars-integration",
      unlink: async () => {},
    });
    assert.equal(again.deleted, false);
    assert.equal(again.reason, "not_found");
    const tombstoneStill = await iso.pool.query(
      `SELECT 1 FROM privacy_suppressions WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(tombstoneStill.rowCount, 1);

    // Re-login can create new ongoing DB stances (e.g. bip54); seed still suppressed.
    await iso.pool.query(
      `INSERT INTO community_users (x_user_id, handle, stance)
       VALUES ($1, $2, NULL)`,
      [xUserId, handle]
    );
    await iso.pool.query(
      `INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance)
       VALUES ($1, 'bip54', 'approve')`,
      [xUserId]
    );
    const dbStance = await iso.pool.query(
      `SELECT stance FROM user_proposal_stances WHERE x_user_id = $1 AND proposal_id = 'bip54'`,
      [xUserId]
    );
    assert.equal(dbStance.rows[0].stance, "approve");

    const keysAfterRelogin = await loadPrivacySuppressionKeys(iso.pool);
    const seedStillHidden = filterPrivacySuppressedAccounts(curatedSeed, keysAfterRelogin);
    assert.ok(!seedStillHidden.some((a) => a.x_user_id === xUserId));
  } finally {
    await iso.cleanup();
  }
});

test("integration: ordinary deletion + upsertPrivacySuppression idempotency", async () => {
  const iso = await createIsolatedSchemaPool("orddel");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensurePrivacySuppressionsTable(iso.pool);

    const xUserId = uniqueTestId("ordinary");
    const handle = `user_${xUserId.slice(-8)}`;
    await seedUser(iso.pool, { x_user_id: xUserId, handle, bip110Stance: "neutral" });

    const first = await upsertPrivacySuppression(iso.pool, {
      x_user_id: xUserId,
      handle: `@${handle}`,
    });
    assert.equal(first.handle_normalized, handle.toLowerCase());
    const second = await upsertPrivacySuppression(iso.pool, {
      x_user_id: xUserId,
      handle,
    });
    assert.equal(second.x_user_id, xUserId);
    const count = await iso.pool.query(
      `SELECT COUNT(*)::int AS c FROM privacy_suppressions WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(count.rows[0].c, 1);

    // Clear pre-seeded tombstone so delete path writes it in-transaction.
    await iso.pool.query(`DELETE FROM privacy_suppressions WHERE x_user_id = $1`, [xUserId]);

    const result = await deleteAuthenticatedAccount({
      pool: iso.pool,
      sessionUser: { x_user_id: xUserId, handle: `@${handle}` },
      avatarsDir: "/tmp/avatars-integration",
      unlink: async () => {},
    });
    assert.equal(result.deleted, true);

    for (const table of [
      "community_users",
      "sessions",
      "stance_events",
      "stance_history",
      "user_proposal_stances",
      "user_proposal_stance_history",
      "removed_community_users",
    ]) {
      const r = await iso.pool.query(`SELECT 1 FROM ${table} WHERE x_user_id = $1`, [xUserId]);
      assert.equal(r.rowCount, 0, `${table} should be cleared`);
    }
    const suppressed = await iso.pool.query(
      `SELECT 1 FROM privacy_suppressions WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(suppressed.rowCount, 1);
  } finally {
    await iso.cleanup();
  }
});

test("integration: account deletion transaction rolls back on mid-flight failure", async () => {
  const iso = await createIsolatedSchemaPool("rollback");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensurePrivacySuppressionsTable(iso.pool);

    const xUserId = uniqueTestId("rollback_user");
    const handle = `rb_${xUserId.slice(-8)}`;
    await seedUser(iso.pool, { x_user_id: xUserId, handle });

    // Break a table deleteAuthenticatedAccount always touches after the tombstone upsert.
    await iso.pool.query(`DROP TABLE stance_events`);

    await assert.rejects(
      () =>
        deleteAuthenticatedAccount({
          pool: iso.pool,
          sessionUser: { x_user_id: xUserId, handle },
          avatarsDir: "/tmp/avatars-integration",
          unlink: async () => {},
        }),
      /stance_events|does not exist|relation/i
    );

    const userStill = await iso.pool.query(
      `SELECT handle FROM community_users WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(userStill.rowCount, 1);
    assert.equal(userStill.rows[0].handle, handle);

    const noTombstone = await iso.pool.query(
      `SELECT 1 FROM privacy_suppressions WHERE x_user_id = $1`,
      [xUserId]
    );
    assert.equal(noTombstone.rowCount, 0, "tombstone must roll back with the transaction");

    const stanceStill = await iso.pool.query(
      `SELECT 1 FROM user_proposal_stances WHERE x_user_id = $1 AND proposal_id = 'bip110'`,
      [xUserId]
    );
    assert.equal(stanceStill.rowCount, 1);
  } finally {
    await iso.cleanup();
  }
});
