/**
 * Real Postgres integration tests for durable OAuth pending-state store.
 * Requires TEST_DATABASE_URL (enforced by helpers + require-integration-passes).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import {
  cleanupExpiredOAuthStates,
  consumeOAuthState,
  ensureOAuthStateTable,
  saveOAuthState,
} from "../oauthStateStore.js";
import {
  assertSafeTestDatabaseUrl,
  createIsolatedSchemaPool,
  getRequiredTestDatabaseUrl,
  uniqueTestId,
} from "./helpers.js";

const TEST_DATABASE_URL = getRequiredTestDatabaseUrl();
assertSafeTestDatabaseUrl(TEST_DATABASE_URL);

test("integration: oauth state ensure/save/consume once, wrong browser, expire, cleanup", async () => {
  const iso = await createIsolatedSchemaPool("oauth");
  try {
    await ensureOAuthStateTable(iso.pool);
    await ensureOAuthStateTable(iso.pool); // idempotent

    const now = new Date("2026-08-13T12:00:00.000Z");
    const state = uniqueTestId("oauth_state");
    const nonce = uniqueTestId("nonce");

    const saved = await saveOAuthState(iso.pool, {
      state,
      code_verifier: "verifier-abc",
      mode: "popup",
      browser_nonce: nonce,
      now,
      ttlMs: 60_000,
    });
    assert.equal(saved.state, state);
    assert.equal(saved.browser_nonce, nonce);
    assert.equal(saved.mode, "popup");
    assert.equal(saved.code_verifier, "verifier-abc");

    const wrong = await consumeOAuthState(iso.pool, state, "wrong-browser", { now });
    assert.equal(wrong, null);

    const stillThere = await iso.pool.query(
      `SELECT state, browser_nonce FROM oauth_pending_states WHERE state = $1`,
      [state]
    );
    assert.equal(stillThere.rowCount, 1);
    assert.equal(stillThere.rows[0].browser_nonce, nonce);

    const first = await consumeOAuthState(iso.pool, state, nonce, { now });
    assert.ok(first);
    assert.equal(first!.code_verifier, "verifier-abc");

    const replay = await consumeOAuthState(iso.pool, state, nonce, { now });
    assert.equal(replay, null);

    const expiredState = uniqueTestId("oauth_expired");
    await saveOAuthState(iso.pool, {
      state: expiredState,
      code_verifier: "v-expired",
      browser_nonce: nonce,
      now,
      ttlMs: 1_000,
    });
    const afterExpiry = new Date(now.getTime() + 5_000);
    assert.equal(
      await consumeOAuthState(iso.pool, expiredState, nonce, { now: afterExpiry }),
      null
    );

    const freshState = uniqueTestId("oauth_fresh");
    await saveOAuthState(iso.pool, {
      state: freshState,
      code_verifier: "v-fresh",
      browser_nonce: nonce,
      now: afterExpiry,
      ttlMs: 60_000,
    });
    // Leave the expired row in place; cleanup should remove only it.
    const removed = await cleanupExpiredOAuthStates(iso.pool, { now: afterExpiry });
    assert.ok(removed >= 1);
    const leftover = await iso.pool.query(
      `SELECT state FROM oauth_pending_states WHERE state = ANY($1::text[])`,
      [[expiredState, freshState]]
    );
    assert.deepEqual(
      leftover.rows.map((r) => r.state),
      [freshState]
    );
  } finally {
    await iso.cleanup();
  }
});

test("integration: two pools (concurrent server instances) — exactly one consumer wins", async () => {
  const iso = await createIsolatedSchemaPool("oauth_race");
  const url = TEST_DATABASE_URL;
  const poolA = new Pool({
    connectionString: url,
    max: 2,
    options: `-c search_path=${iso.schema}`,
  });
  const poolB = new Pool({
    connectionString: url,
    max: 2,
    options: `-c search_path=${iso.schema}`,
  });

  try {
    await ensureOAuthStateTable(iso.pool);
    const now = new Date("2026-08-13T12:30:00.000Z");
    const state = uniqueTestId("oauth_race");
    const nonce = uniqueTestId("nonce_race");

    await saveOAuthState(iso.pool, {
      state,
      code_verifier: "shared-verifier",
      mode: "redirect",
      browser_nonce: nonce,
      now,
      ttlMs: 120_000,
    });

    const [a, b] = await Promise.all([
      consumeOAuthState(poolA, state, nonce, { now }),
      consumeOAuthState(poolB, state, nonce, { now }),
    ]);

    const wins = [a, b].filter(Boolean);
    assert.equal(wins.length, 1, "exactly one concurrent consumer must succeed");
    assert.equal(wins[0]!.code_verifier, "shared-verifier");

    const remaining = await iso.pool.query(
      `SELECT 1 FROM oauth_pending_states WHERE state = $1`,
      [state]
    );
    assert.equal(remaining.rowCount, 0);
  } finally {
    await poolA.end();
    await poolB.end();
    await iso.cleanup();
  }
});
