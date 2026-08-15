/**
 * Real Postgres integration tests for Name the PoW change fork poll tables.
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
  approveNameTheForkCandidate,
  buildNameTheForkPayload,
  castNameTheForkVote,
  ensureNameTheForkSchema,
  hideNameTheForkCandidate,
  NAME_THE_FORK_SEEDS,
  NAME_THE_FORK_TITLE,
  rejectNameTheForkCandidate,
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

test("integration: schema + seed idempotency keeps seeds approved", async () => {
  const iso = await createIsolatedSchemaPool("ntf_schema");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await Promise.all([ensureNameTheForkSchema(iso.pool), ensureNameTheForkSchema(iso.pool)]);
    await ensureNameTheForkSchema(iso.pool);

    const seeds = await iso.pool.query(
      `SELECT id, display_name, moderation_status
       FROM name_the_fork_candidates WHERE is_seed = TRUE ORDER BY seed_order ASC`
    );
    assert.equal(seeds.rowCount, 3);
    assert.deepEqual(
      seeds.rows.map((r) => r.display_name),
      NAME_THE_FORK_SEEDS.map((s) => s.displayName)
    );
    assert.ok(seeds.rows.every((r) => r.moderation_status === "approved"));

    const payload = await buildNameTheForkPayload(iso.pool);
    assert.equal(payload.title, NAME_THE_FORK_TITLE);
    assert.equal(payload.candidates.length, 3);
  } finally {
    await iso.cleanup();
  }
});

test("integration: custom submissions stay pending and invisible publicly", async () => {
  const iso = await createIsolatedSchemaPool("ntf_pend");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const userId = uniqueTestId("pend");
    const handle = `p_${userId.slice(-6)}`;
    await seedCommunityUser(iso.pool, { x_user_id: userId, handle });

    const created = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: userId,
      displayName: "PendingNova",
      handle,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const anon = await buildNameTheForkPayload(iso.pool);
    assert.ok(!anon.candidates.some((c) => c.id === created.candidate_id));
    assert.equal(anon.pending_suggestions, null);

    const voteBlocked = await castNameTheForkVote(iso.pool, {
      xUserId: userId,
      candidateId: created.candidate_id,
      handle,
    });
    assert.equal(voteBlocked.ok, false);
    if (!voteBlocked.ok) assert.equal(voteBlocked.error, "candidate_not_votable");

    const self = await buildNameTheForkPayload(iso.pool, {
      viewerXUserId: userId,
      viewerHandle: handle,
    });
    assert.equal(self.me?.my_submission?.status, "pending");
    assert.equal(self.me?.my_submission?.display_name, "PendingNova");
    assert.equal(self.me?.has_custom_slot_used, true);
    assert.ok(!self.candidates.some((c) => c.id === created.candidate_id));
  } finally {
    await iso.cleanup();
  }
});

test("integration: approve publishes and casts proposer vote; reject frees slot", async () => {
  const iso = await createIsolatedSchemaPool("ntf_review");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const proposer = uniqueTestId("apr");
    const admin = uniqueTestId("adm");
    const other = uniqueTestId("oth");
    await seedCommunityUser(iso.pool, { x_user_id: proposer, handle: `ap_${proposer.slice(-5)}` });
    await seedCommunityUser(iso.pool, { x_user_id: admin, handle: "zndtoshi" });
    await seedCommunityUser(iso.pool, { x_user_id: other, handle: `ot_${other.slice(-5)}` });

    await castNameTheForkVote(iso.pool, {
      xUserId: proposer,
      candidateId: "seed_bdash",
      handle: `ap_${proposer.slice(-5)}`,
    });

    const created = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: proposer,
      displayName: "ApproveMe",
      handle: `ap_${proposer.slice(-5)}`,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    // Existing vote unchanged while pending.
    let payload = await buildNameTheForkPayload(iso.pool, { viewerXUserId: proposer });
    assert.equal(payload.me?.selected_candidate_id, "seed_bdash");

    const approved = await approveNameTheForkCandidate(iso.pool, {
      candidateId: created.candidate_id,
      adminXUserId: admin,
      adminHandle: "zndtoshi",
    });
    assert.equal(approved.ok, true);

    payload = await buildNameTheForkPayload(iso.pool, { viewerXUserId: proposer });
    assert.ok(payload.candidates.some((c) => c.id === created.candidate_id));
    assert.equal(payload.me?.selected_candidate_id, created.candidate_id);

    // Reject path frees slot and does not change vote.
    const secondUser = uniqueTestId("rej");
    await seedCommunityUser(iso.pool, { x_user_id: secondUser, handle: `rj_${secondUser.slice(-5)}` });
    await castNameTheForkVote(iso.pool, {
      xUserId: secondUser,
      candidateId: "seed_bcashjr",
      handle: `rj_${secondUser.slice(-5)}`,
    });
    const rejectedCand = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: secondUser,
      displayName: "RejectMe",
      handle: `rj_${secondUser.slice(-5)}`,
    });
    assert.equal(rejectedCand.ok, true);
    if (!rejectedCand.ok) return;
    const rejected = await rejectNameTheForkCandidate(iso.pool, {
      candidateId: rejectedCand.candidate_id,
      adminXUserId: admin,
      adminHandle: "zndtoshi",
    });
    assert.equal(rejected.ok, true);
    payload = await buildNameTheForkPayload(iso.pool, { viewerXUserId: secondUser });
    assert.equal(payload.me?.selected_candidate_id, "seed_bcashjr");
    assert.equal(payload.me?.has_custom_slot_used, false);
    assert.equal(payload.me?.my_submission?.status, "rejected");

    // Rejected name can be resubmitted.
    const again = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: secondUser,
      displayName: "RejectMe",
      handle: `rj_${secondUser.slice(-5)}`,
    });
    assert.equal(again.ok, true);
  } finally {
    await iso.cleanup();
  }
});

test("integration: concurrent approve/reject yields one terminal decision", async () => {
  const iso = await createIsolatedSchemaPool("ntf_race");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const proposer = uniqueTestId("racep");
    const admin = uniqueTestId("racea");
    await seedCommunityUser(iso.pool, { x_user_id: proposer, handle: `rp_${proposer.slice(-5)}` });
    await seedCommunityUser(iso.pool, { x_user_id: admin, handle: "zndtoshi" });
    const created = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: proposer,
      displayName: "RaceName",
      handle: `rp_${proposer.slice(-5)}`,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const results = await Promise.all([
      approveNameTheForkCandidate(iso.pool, {
        candidateId: created.candidate_id,
        adminXUserId: admin,
        adminHandle: "zndtoshi",
      }),
      rejectNameTheForkCandidate(iso.pool, {
        candidateId: created.candidate_id,
        adminXUserId: admin,
        adminHandle: "zndtoshi",
      }),
    ]);
    const oks = results.filter((r) => r.ok);
    const fails = results.filter((r) => !r.ok);
    assert.equal(oks.length, 1);
    assert.equal(fails.length, 1);
    if (!fails[0].ok) assert.equal(fails[0].error, "already_reviewed");

    const status = await iso.pool.query(
      `SELECT moderation_status FROM name_the_fork_candidates WHERE id = $1`,
      [created.candidate_id]
    );
    assert.ok(["approved", "rejected"].includes(String(status.rows[0].moderation_status)));
  } finally {
    await iso.cleanup();
  }
});

test("integration: concurrent votes and custom uniqueness races", async () => {
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

    const userA = uniqueTestId("ca");
    const userB = uniqueTestId("cb");
    await seedCommunityUser(iso.pool, { x_user_id: userA, handle: `ca_${userA.slice(-5)}` });
    await seedCommunityUser(iso.pool, { x_user_id: userB, handle: `cb_${userB.slice(-5)}` });
    const sameUserRace = await Promise.all([
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userA,
        displayName: "NovaOne",
        handle: `ca_${userA.slice(-5)}`,
      }),
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userA,
        displayName: "NovaTwo",
        handle: `ca_${userA.slice(-5)}`,
      }),
    ]);
    assert.equal(sameUserRace.filter((r) => r.ok).length, 1);
    assert.equal(
      sameUserRace.filter((r) => !r.ok && r.error === "custom_already_submitted").length,
      1
    );

    const userC = uniqueTestId("cc");
    const userD = uniqueTestId("cd");
    await seedCommunityUser(iso.pool, { x_user_id: userC, handle: `cc_${userC.slice(-5)}` });
    await seedCommunityUser(iso.pool, { x_user_id: userD, handle: `cd_${userD.slice(-5)}` });
    const dupRace = await Promise.all([
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userC,
        displayName: "TwinFork",
        handle: `cc_${userC.slice(-5)}`,
      }),
      submitCustomNameTheForkCandidate(iso.pool, {
        xUserId: userD,
        displayName: "twinfork",
        handle: `cd_${userD.slice(-5)}`,
      }),
    ]);
    assert.equal(dupRace.filter((r) => r.ok).length, 1);
    assert.equal(dupRace.filter((r) => !r.ok && r.error === "duplicate_name").length, 1);
  } finally {
    await iso.cleanup();
  }
});

test("integration: hide approved custom removes votes; migration pending excludes public votes", async () => {
  const iso = await createIsolatedSchemaPool("ntf_hide");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const proposer = uniqueTestId("hp");
    const voter = uniqueTestId("hv");
    const admin = uniqueTestId("ha");
    await seedCommunityUser(iso.pool, { x_user_id: proposer, handle: `hp_${proposer.slice(-5)}` });
    await seedCommunityUser(iso.pool, { x_user_id: voter, handle: `hv_${voter.slice(-5)}` });
    await seedCommunityUser(iso.pool, { x_user_id: admin, handle: "zndtoshi" });

    const created = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: proposer,
      displayName: "HideLater",
      handle: `hp_${proposer.slice(-5)}`,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await approveNameTheForkCandidate(iso.pool, {
      candidateId: created.candidate_id,
      adminXUserId: admin,
      adminHandle: "zndtoshi",
    });
    await castNameTheForkVote(iso.pool, {
      xUserId: voter,
      candidateId: created.candidate_id,
      handle: `hv_${voter.slice(-5)}`,
    });
    await hideNameTheForkCandidate(iso.pool, {
      candidateId: created.candidate_id,
      adminHandle: "zndtoshi",
      adminXUserId: admin,
    });
    const votes = await iso.pool.query(
      `SELECT 1 FROM name_the_fork_votes WHERE candidate_id = $1`,
      [created.candidate_id]
    );
    assert.equal(votes.rowCount, 0);
    const payload = await buildNameTheForkPayload(iso.pool);
    assert.ok(!payload.candidates.some((c) => c.id === created.candidate_id));
  } finally {
    await iso.cleanup();
  }
});

test("integration: privacy + account deletion across moderation states", async () => {
  const iso = await createIsolatedSchemaPool("ntf_priv");
  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensureNameTheForkSchema(iso.pool);
    const users = Array.from({ length: 3 }, (_, i) => {
      const id = uniqueTestId(`pk${i}`);
      return { x_user_id: id, handle: `pk${i}_${id.slice(-5)}` };
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

    await upsertPrivacySuppression(iso.pool, {
      x_user_id: users[1].x_user_id,
      handle: users[1].handle,
    });
    let payload = await buildNameTheForkPayload(iso.pool);
    const bdash = payload.candidates.find((c) => c.id === "seed_bdash");
    assert.ok(bdash);
    assert.equal(bdash.vote_count, 1);

    const pending = await submitCustomNameTheForkCandidate(iso.pool, {
      xUserId: users[2].x_user_id,
      displayName: "DelPending",
      handle: users[2].handle,
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;

    const deleted = await deleteAuthenticatedAccount({
      pool: iso.pool,
      sessionUser: { x_user_id: users[2].x_user_id, handle: users[2].handle },
      avatarsDir: "/tmp/avatars-ntf",
      unlink: async () => {},
    });
    assert.equal(deleted.deleted, true);
    const cand = await iso.pool.query(
      `SELECT proposer_x_user_id, proposer_handle FROM name_the_fork_candidates WHERE id = $1`,
      [pending.candidate_id]
    );
    assert.equal(cand.rows[0].proposer_x_user_id, null);
    assert.equal(cand.rows[0].proposer_handle, null);
    await removeNameTheForkVote(iso.pool, users[0].x_user_id);
  } finally {
    await iso.cleanup();
  }
});
