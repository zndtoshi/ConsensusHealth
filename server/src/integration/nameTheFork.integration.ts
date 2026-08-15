/**
 * Real Postgres integration tests for Name the Fork poll tables.
 * Requires TEST_DATABASE_URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { deleteAuthenticatedAccount } from "../accountDeletion.js";
import { upsertPrivacySuppression } from "../privacySuppressions.js";
import {
  assertSafeTestDatabaseUrl,
  createIsolatedSchemaPool,
  ensureAccountDeletionSchema,
  getRequiredTestDatabaseUrl,
  uniqueTestId,
} from "./helpers.js";
import {
  buildNameTheForkPayload,
  castNameTheForkVote,
  ensureNameTheForkSchema,
  hideNameTheForkCandidate,
  NAME_THE_FORK_SEEDS,
  removeNameTheForkVote,
  submitCustomNameTheForkCandidate,
} from "../nameTheFork.js";

const TEST_DATABASE_URL = getRequiredTestDatabaseUrl();
assertSafeTestDatabaseUrl(TEST_DATABASE_URL);

async function seedCommunityUser(
  pool: Pool,
  user: { x_user_id: string; handle: string }
) {
  await pool.query(
    `INSERT INTO community_users (x_user_id, handle, stance, avatar_path)
     VALUES ($1, $2, 'against', $3)
     ON CONFLICT (x_user_id) DO UPDATE SET handle = EXCLUDED.handle`,
    [user.x_user_id, user.handle, `/avatars/${user.x_user_id}.jpg`]
  );
}

test("integration: Name the Fork schema + seed idempotency (serial and concurrent)", async () => {
  const iso = await createIsolatedSchemaPool("ntf_schema");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await Promise.all([
      ensureNameTheForkSchema(iso.pool),
      ensureNameTheForkSchema(iso.pool),
    ]);
    await ensureNameTheForkSchema(iso.pool);

    const seeds = await iso.pool.query(
      `SELECT id, display_name FROM name_the_fork_candidates WHERE is_seed = TRUE ORDER BY seed_order ASC`
    );
    assert.equal(seeds.rowCount, 3);
    assert.deepEqual(
      seeds.rows.map((r) => r.display_name),
      NAME_THE_FORK_SEEDS.map((s) => s.displayName)
    );

    const userId = uniqueTestId("ntf_u");
    await seedCommunityUser(iso.pool, { x_user_id: userId, handle: `h_${userId.slice(-6)}` });
    const vote = await castNameTheForkVote(iso.pool, {
      xUserId: userId,
      candidateId: "seed_bdash",
      handle: `h_${userId.slice(-6)}`,
    });
    assert.equal(vote.ok, true);

    await ensureNameTheForkSchema(iso.pool);
    const votes = await iso.pool.query(
      `SELECT candidate_id FROM name_the_fork_votes WHERE x_user_id = $1`,
      [userId]
    );
    assert.equal(votes.rowCount, 1);
    assert.equal(votes.rows[0].candidate_id, "seed_bdash");
  } finally {
    await iso.cleanup();
  }
});

test("integration: concurrent votes for one user leave exactly one row", async () => {
  const iso = await createIsolatedSchemaPool("ntf_vote");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const userId = uniqueTestId("voter");
    await seedCommunityUser(iso.pool, { x_user_id: userId, handle: `v_${userId.slice(-6)}` });

    const results = await Promise.all([
      castNameTheForkVote(iso.pool, { xUserId: userId, candidateId: "seed_bcashjr", handle: "a" }),
      castNameTheForkVote(iso.pool, { xUserId: userId, candidateId: "seed_bdash", handle: "a" }),
      castNameTheForkVote(iso.pool, { xUserId: userId, candidateId: "seed_bitcoin110", handle: "a" }),
    ]);
    assert.ok(results.every((r) => r.ok));

    const votes = await iso.pool.query(
      `SELECT candidate_id FROM name_the_fork_votes WHERE x_user_id = $1`,
      [userId]
    );
    assert.equal(votes.rowCount, 1);
    assert.ok(
      ["seed_bcashjr", "seed_bdash", "seed_bitcoin110"].includes(String(votes.rows[0].candidate_id))
    );
  } finally {
    await iso.cleanup();
  }
});

test("integration: concurrent custom submissions and normalization races", async () => {
  const iso = await createIsolatedSchemaPool("ntf_custom");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);

    const userA = uniqueTestId("ca");
    const userB = uniqueTestId("cb");
    await seedCommunityUser(iso.pool, { x_user_id: userA, handle: `ca_${userA.slice(-6)}` });
    await seedCommunityUser(iso.pool, { x_user_id: userB, handle: `cb_${userB.slice(-6)}` });

    const sameUserRace = await Promise.all([
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userA,
        displayName: "NovaOne",
        handle: `ca_${userA.slice(-6)}`,
      }),
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userA,
        displayName: "NovaTwo",
        handle: `ca_${userA.slice(-6)}`,
      }),
    ]);
    const sameUserOk = sameUserRace.filter((r) => r.ok);
    const sameUserErr = sameUserRace.filter((r) => !r.ok);
    assert.equal(sameUserOk.length, 1);
    assert.equal(sameUserErr.length, 1);
    if (!sameUserErr[0].ok) {
      assert.equal(sameUserErr[0].error, "custom_already_submitted");
    }
    const customCountA = await iso.pool.query(
      `SELECT id FROM name_the_fork_candidates WHERE proposer_x_user_id = $1 AND is_seed = FALSE`,
      [userA]
    );
    assert.equal(customCountA.rowCount, 1);

    const userC = uniqueTestId("cc");
    const userD = uniqueTestId("cd");
    await seedCommunityUser(iso.pool, { x_user_id: userC, handle: `cc_${userC.slice(-6)}` });
    await seedCommunityUser(iso.pool, { x_user_id: userD, handle: `cd_${userD.slice(-6)}` });
    const dupRace = await Promise.all([
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userC,
        displayName: "TwinFork",
        handle: `cc_${userC.slice(-6)}`,
      }),
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userD,
        displayName: "twinfork",
        handle: `cd_${userD.slice(-6)}`,
      }),
    ]);
    const dupOk = dupRace.filter((r) => r.ok);
    const dupErr = dupRace.filter((r) => !r.ok);
    assert.equal(dupOk.length, 1);
    assert.equal(dupErr.length, 1);
    if (!dupErr[0].ok) {
      assert.equal(dupErr[0].error, "duplicate_name");
    }
    const twinCount = await iso.pool.query(
      `SELECT id FROM name_the_fork_candidates WHERE normalized_key = 'twinfork'`
    );
    assert.equal(twinCount.rowCount, 1);
  } finally {
    await iso.cleanup();
  }
});

test("integration: create+vote rollback leaves no orphan candidate or vote", async () => {
  const iso = await createIsolatedSchemaPool("ntf_rb");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const userId = uniqueTestId("rb");
    await seedCommunityUser(iso.pool, { x_user_id: userId, handle: `rb_${userId.slice(-6)}` });

    const client = await iso.pool.connect();
    const origQuery = client.query.bind(client);
    let sawCandidateInsert = false;
    (client as { query: typeof client.query }).query = (async (
      sql: string | { text?: string },
      params?: unknown[]
    ) => {
      const text = typeof sql === "string" ? sql : String(sql?.text || "");
      if (/INSERT INTO name_the_fork_candidates/i.test(text)) {
        sawCandidateInsert = true;
        return origQuery(sql as never, params as never);
      }
      if (sawCandidateInsert && /INSERT INTO name_the_fork_votes/i.test(text)) {
        throw Object.assign(new Error("forced vote failure"), { code: "23503" });
      }
      return origQuery(sql as never, params as never);
    }) as typeof client.query;

    const wrappedPool = {
      connect: async () => client,
      query: iso.pool.query.bind(iso.pool),
    } as unknown as Pool;

    await assert.rejects(
      () =>
        submitCustomNameTheForkCandidate(wrappedPool, {
          xUserId: userId,
          displayName: "OrphanProbe",
          handle: `rb_${userId.slice(-6)}`,
        }),
      /forced vote failure/
    );

    const cands = await iso.pool.query(
      `SELECT id FROM name_the_fork_candidates WHERE display_name = 'OrphanProbe'`
    );
    assert.equal(cands.rowCount, 0);
    const votes = await iso.pool.query(
      `SELECT x_user_id FROM name_the_fork_votes WHERE x_user_id = $1`,
      [userId]
    );
    assert.equal(votes.rowCount, 0);
  } finally {
    await iso.cleanup();
  }
});

test("integration: vote vs hide race clears accepted votes on hide", async () => {
  const iso = await createIsolatedSchemaPool("ntf_hide");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const proposer = uniqueTestId("hp");
    const voter = uniqueTestId("hv");
    await seedCommunityUser(iso.pool, { x_user_id: proposer, handle: `hp_${proposer.slice(-6)}` });
    await seedCommunityUser(iso.pool, { x_user_id: voter, handle: `hv_${voter.slice(-6)}` });

    const created = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: proposer,
      displayName: "HideRace",
      handle: `hp_${proposer.slice(-6)}`,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const candidateId = created.candidate_id;

    const raced = await Promise.all([
      castNameTheForkVote(iso.pool, {
        xUserId: voter,
        candidateId,
        handle: `hv_${voter.slice(-6)}`,
      }),
      hideNameTheForkCandidate(iso.pool, {
        candidateId,
        adminHandle: "zndtoshi",
      }),
    ]);
    assert.ok(raced[1].ok);

    const votes = await iso.pool.query(
      `SELECT x_user_id FROM name_the_fork_votes WHERE candidate_id = $1`,
      [candidateId]
    );
    assert.equal(votes.rowCount, 0);

    const payload = await buildNameTheForkPayload(iso.pool);
    assert.ok(!payload.candidates.some((c) => c.id === candidateId));
  } finally {
    await iso.cleanup();
  }
});

test("integration: ranking, hidden exclusion, privacy, and account deletion", async () => {
  const iso = await createIsolatedSchemaPool("ntf_rank");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);

    const users = Array.from({ length: 4 }, (_, i) => {
      const id = uniqueTestId(`rk${i}`);
      return { x_user_id: id, handle: `rk${i}_${id.slice(-5)}` };
    });
    for (const u of users) await seedCommunityUser(iso.pool, u);

    await castNameTheForkVote(iso.pool, {
      xUserId: users[0].x_user_id,
      candidateId: "seed_bdash",
      handle: users[0].handle,
    });
    await castNameTheForkVote(iso.pool, {
      xUserId: users[1].x_user_id,
      candidateId: "seed_bdash",
      handle: users[1].handle,
    });
    await castNameTheForkVote(iso.pool, {
      xUserId: users[2].x_user_id,
      candidateId: "seed_bcashjr",
      handle: users[2].handle,
    });

    const custom = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: users[3].x_user_id,
      displayName: "RankCustom",
      handle: users[3].handle,
    });
    assert.equal(custom.ok, true);
    if (!custom.ok) return;

    let payload = await buildNameTheForkPayload(iso.pool, {
      viewerXUserId: users[0].x_user_id,
    });
    assert.equal(payload.candidates[0].id, "seed_bdash");
    assert.equal(payload.candidates[0].vote_count, 2);
    assert.equal(payload.total_voters, 4);
    assert.ok(payload.candidates.some((c) => c.id === custom.candidate_id));

    await hideNameTheForkCandidate(iso.pool, {
      candidateId: custom.candidate_id,
      adminHandle: "zndtoshi",
    });
    payload = await buildNameTheForkPayload(iso.pool);
    assert.ok(!payload.candidates.some((c) => c.id === custom.candidate_id));
    assert.equal(payload.total_voters, 3);

    await upsertPrivacySuppression(iso.pool, {
      x_user_id: users[1].x_user_id,
      handle: users[1].handle,
    });
    payload = await buildNameTheForkPayload(iso.pool);
    const bdash = payload.candidates.find((c) => c.id === "seed_bdash");
    assert.ok(bdash);
    assert.equal(bdash.vote_count, 1);
    assert.ok(!bdash.voters.some((v) => v.x_user_id === users[1].x_user_id));
    assert.equal(payload.total_voters, 2);

    await removeNameTheForkVote(iso.pool, users[0].x_user_id);
    const deleted = await deleteAuthenticatedAccount({
      pool: iso.pool,
      sessionUser: { x_user_id: users[3].x_user_id, handle: users[3].handle },
      avatarsDir: "/tmp/avatars-ntf",
      unlink: async () => {},
    });
    assert.equal(deleted.deleted, true);

    // Re-create a custom from users[2] then delete to verify proposer anonymization
    // when votes from others exist.
    const other = uniqueTestId("oth");
    await seedCommunityUser(iso.pool, { x_user_id: other, handle: `oth_${other.slice(-5)}` });
    const keep = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: users[2].x_user_id,
      displayName: "KeepAnon",
      handle: users[2].handle,
    });
    assert.equal(keep.ok, true);
    if (!keep.ok) return;
    await castNameTheForkVote(iso.pool, {
      xUserId: other,
      candidateId: keep.candidate_id,
      handle: `oth_${other.slice(-5)}`,
    });
    const delProposer = await deleteAuthenticatedAccount({
      pool: iso.pool,
      sessionUser: { x_user_id: users[2].x_user_id, handle: users[2].handle },
      avatarsDir: "/tmp/avatars-ntf",
      unlink: async () => {},
    });
    assert.equal(delProposer.deleted, true);

    const cand = await iso.pool.query(
      `SELECT proposer_x_user_id, proposer_handle FROM name_the_fork_candidates WHERE id = $1`,
      [keep.candidate_id]
    );
    assert.equal(cand.rowCount, 1);
    assert.equal(cand.rows[0].proposer_x_user_id, null);
    assert.equal(cand.rows[0].proposer_handle, null);

    const votesGone = await iso.pool.query(
      `SELECT 1 FROM name_the_fork_votes WHERE x_user_id = $1`,
      [users[2].x_user_id]
    );
    assert.equal(votesGone.rowCount, 0);

    payload = await buildNameTheForkPayload(iso.pool);
    const anon = payload.candidates.find((c) => c.id === keep.candidate_id);
    assert.ok(anon);
    assert.equal(anon.proposer_handle, null);
  } finally {
    await iso.cleanup();
  }
});
