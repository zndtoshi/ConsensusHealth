/**
 * OAuth community_users find/link/merge using stable x_user_id + handle only.
 * Compatible with legacy schemas that have a numeric `id` and canonical schemas
 * that key solely on `x_user_id` (no `id` column).
 *
 * Privacy suppressions and moderation-removal rows are not rewritten during merge.
 */

import type { PoolClient } from "pg";

export type OauthCommunityProfile = {
  xUserId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  followersCount: number | null;
  bio: string | null;
  accountCreatedAt: string | null;
};

type CommunityUserRow = {
  x_user_id?: string | null;
  handle?: string | null;
  stance?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  followers_count?: number | null;
  bio?: string | null;
  account_created_at?: string | Date | null;
  updated_at?: string | Date | null;
};

type StanceRow = {
  x_user_id: string;
  proposal_id: string;
  stance: string;
  updated_at?: string | Date | null;
};

type ExplanationRow = Record<string, unknown> & {
  x_user_id: string;
  proposal_id: string;
  stance_at_verification?: string | null;
  verified_at?: string | Date | null;
  updated_at?: string | Date | null;
};

const DEPENDENT_SIMPLE_TABLES = ["sessions", "stance_events"] as const;

function normHandle(handle: string): string {
  return String(handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function asTime(value: unknown): number {
  if (value == null) return 0;
  const t = new Date(value as string | Date).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1
     LIMIT 1`,
    [table]
  );
  return (res.rowCount ?? 0) > 0;
}

async function listColumns(client: PoolClient, table: string): Promise<string[]> {
  const res = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return res.rows.map((r) => String(r.column_name));
}

async function fetchByXUserId(
  client: PoolClient,
  xUserId: string
): Promise<CommunityUserRow | undefined> {
  const res = await client.query(`SELECT * FROM community_users WHERE x_user_id = $1 LIMIT 1`, [
    xUserId,
  ]);
  return res.rows[0] as CommunityUserRow | undefined;
}

async function fetchByHandle(
  client: PoolClient,
  handle: string
): Promise<CommunityUserRow | undefined> {
  const res = await client.query(
    `
      SELECT * FROM community_users
      WHERE lower(coalesce(handle, '')) = $1
      ORDER BY (stance IS NOT NULL) DESC, updated_at DESC NULLS LAST
      LIMIT 1
    `,
    [handle]
  );
  return res.rows[0] as CommunityUserRow | undefined;
}

async function updateProfileByXUserId(
  client: PoolClient,
  xUserId: string,
  p: OauthCommunityProfile,
  opts?: { stance?: string | null }
): Promise<void> {
  await client.query(
    `
      UPDATE community_users
      SET handle = $2,
          name = COALESCE(NULLIF($3, ''), community_users.name),
          avatar_url = COALESCE(NULLIF($4, ''), community_users.avatar_url),
          followers_count = COALESCE(NULLIF($5, 0), community_users.followers_count),
          bio = CASE
            WHEN NULLIF($6, '') IS NOT NULL THEN $6
            ELSE community_users.bio
          END,
          account_created_at = COALESCE(community_users.account_created_at, $7::timestamptz),
          stance = COALESCE(community_users.stance, $8),
          updated_at = now()
      WHERE x_user_id = $1
    `,
    [
      xUserId,
      p.handle,
      p.name,
      p.avatarUrl,
      p.followersCount,
      p.bio,
      p.accountCreatedAt,
      opts?.stance ?? null,
    ]
  );
}

async function insertNewUser(client: PoolClient, p: OauthCommunityProfile): Promise<void> {
  await client.query(
    `
      INSERT INTO community_users (
        x_user_id,
        handle,
        name,
        avatar_url,
        followers_count,
        bio,
        account_created_at,
        stance,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, NULL, now())
    `,
    [p.xUserId, p.handle, p.name, p.avatarUrl, p.followersCount, p.bio, p.accountCreatedAt]
  );
}

/**
 * Deterministic stance winner for one proposal.
 * Prefer non-null stance; if both set, newer updated_at wins; ties keep the target row.
 */
export function pickWinningProposalStance(
  target: StanceRow | undefined,
  source: StanceRow | undefined
): StanceRow | undefined {
  if (!target && !source) return undefined;
  if (target && !source) return target;
  if (source && !target) return source;
  const t = target!;
  const s = source!;
  const tHas = Boolean(t.stance);
  const sHas = Boolean(s.stance);
  if (sHas && !tHas) return s;
  if (tHas && !sHas) return t;
  const tTime = asTime(t.updated_at);
  const sTime = asTime(s.updated_at);
  if (sTime > tTime) return s;
  return t;
}

function pickWinningExplanation(
  winningStance: string,
  target: ExplanationRow | undefined,
  source: ExplanationRow | undefined
): ExplanationRow | undefined {
  const candidates = [target, source].filter((row): row is ExplanationRow => {
    if (!row) return false;
    return String(row.stance_at_verification || "") === winningStance;
  });
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => {
    const av = asTime(a.verified_at) || asTime(a.updated_at);
    const bv = asTime(b.verified_at) || asTime(b.updated_at);
    return bv - av;
  });
  return candidates[0];
}

async function upsertStance(
  client: PoolClient,
  toXUserId: string,
  row: StanceRow
): Promise<void> {
  await client.query(
    `
      INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance, updated_at)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
      ON CONFLICT (x_user_id, proposal_id)
      DO UPDATE SET
        stance = EXCLUDED.stance,
        updated_at = EXCLUDED.updated_at
    `,
    [toXUserId, row.proposal_id, row.stance, row.updated_at ?? null]
  );
}

async function replaceExplanationForProposal(
  client: PoolClient,
  toXUserId: string,
  proposalId: string,
  winner: ExplanationRow | undefined,
  columns: string[]
): Promise<void> {
  await client.query(
    `DELETE FROM user_proposal_stance_explanations
     WHERE x_user_id = $1 AND proposal_id = $2`,
    [toXUserId, proposalId]
  );
  if (!winner) return;

  const writable = columns.filter((c) => c !== "x_user_id");
  const colList = ["x_user_id", ...writable];
  const values = colList.map((col) => {
    if (col === "x_user_id") return toXUserId;
    return winner[col] ?? null;
  });
  const placeholders = colList.map((_, i) => `$${i + 1}`).join(", ");
  await client.query(
    `INSERT INTO user_proposal_stance_explanations (${colList.join(", ")})
     VALUES (${placeholders})`,
    values
  );
}

/**
 * Merge proposal stances/explanations from source → target, then move append-only
 * history and true dependents. Does not touch privacy_suppressions / removed_community_users.
 */
export async function reassignCommunityUserDependents(
  client: PoolClient,
  fromXUserId: string,
  toXUserId: string
): Promise<void> {
  if (!fromXUserId || !toXUserId || fromXUserId === toXUserId) return;

  if (await tableExists(client, "user_proposal_stances")) {
    const fromStances = (
      await client.query(`SELECT * FROM user_proposal_stances WHERE x_user_id = $1`, [fromXUserId])
    ).rows as StanceRow[];
    const toStances = (
      await client.query(`SELECT * FROM user_proposal_stances WHERE x_user_id = $1`, [toXUserId])
    ).rows as StanceRow[];
    const toByProposal = new Map(toStances.map((r) => [r.proposal_id, r]));
    const allProposalIds = new Set([
      ...fromStances.map((r) => r.proposal_id),
      ...toStances.map((r) => r.proposal_id),
    ]);

    const winningByProposal = new Map<string, StanceRow>();
    for (const proposalId of allProposalIds) {
      const winner = pickWinningProposalStance(
        toByProposal.get(proposalId),
        fromStances.find((r) => r.proposal_id === proposalId)
      );
      if (winner) {
        winningByProposal.set(proposalId, winner);
        await upsertStance(client, toXUserId, winner);
      }
    }

    if (await tableExists(client, "user_proposal_stance_explanations")) {
      const expColumns = await listColumns(client, "user_proposal_stance_explanations");
      const fromExps = (
        await client.query(`SELECT * FROM user_proposal_stance_explanations WHERE x_user_id = $1`, [
          fromXUserId,
        ])
      ).rows as ExplanationRow[];
      const toExps = (
        await client.query(`SELECT * FROM user_proposal_stance_explanations WHERE x_user_id = $1`, [
          toXUserId,
        ])
      ).rows as ExplanationRow[];
      const fromExpByProp = new Map(fromExps.map((r) => [r.proposal_id, r]));
      const toExpByProp = new Map(toExps.map((r) => [r.proposal_id, r]));

      for (const proposalId of allProposalIds) {
        const winningStance = winningByProposal.get(proposalId)?.stance;
        if (!winningStance) {
          await client.query(
            `DELETE FROM user_proposal_stance_explanations
             WHERE x_user_id = $1 AND proposal_id = $2`,
            [toXUserId, proposalId]
          );
          continue;
        }
        const winnerExp = pickWinningExplanation(
          winningStance,
          toExpByProp.get(proposalId),
          fromExpByProp.get(proposalId)
        );
        await replaceExplanationForProposal(
          client,
          toXUserId,
          proposalId,
          winnerExp,
          expColumns
        );
      }

      await client.query(`DELETE FROM user_proposal_stance_explanations WHERE x_user_id = $1`, [
        fromXUserId,
      ]);
    }

    await client.query(`DELETE FROM user_proposal_stances WHERE x_user_id = $1`, [fromXUserId]);
  }

  for (const table of ["user_proposal_stance_history", "stance_history"] as const) {
    if (!(await tableExists(client, table))) continue;
    await client.query(`UPDATE ${table} SET x_user_id = $1 WHERE x_user_id = $2`, [
      toXUserId,
      fromXUserId,
    ]);
  }

  for (const table of DEPENDENT_SIMPLE_TABLES) {
    if (!(await tableExists(client, table))) continue;
    await client.query(`UPDATE ${table} SET x_user_id = $1 WHERE x_user_id = $2`, [
      toXUserId,
      fromXUserId,
    ]);
  }
}

async function ensureRowAtOauthId(
  client: PoolClient,
  p: OauthCommunityProfile,
  source: CommunityUserRow | undefined,
  preferStance: string | null | undefined
): Promise<void> {
  const existing = await fetchByXUserId(client, p.xUserId);
  if (existing) {
    await updateProfileByXUserId(client, p.xUserId, p, {
      stance: preferStance ?? existing.stance ?? null,
    });
    if (preferStance && !existing.stance) {
      await client.query(
        `UPDATE community_users SET stance = $1 WHERE x_user_id = $2 AND stance IS NULL`,
        [preferStance, p.xUserId]
      );
    }
    return;
  }

  await client.query(
    `
      INSERT INTO community_users (
        x_user_id,
        handle,
        name,
        avatar_url,
        followers_count,
        bio,
        account_created_at,
        stance,
        updated_at
      )
      VALUES (
        $1, $2,
        COALESCE(NULLIF($3, ''), $8),
        COALESCE(NULLIF($4, ''), $9),
        COALESCE(NULLIF($5, 0), $10),
        COALESCE(NULLIF($6, ''), $11),
        COALESCE($7::timestamptz, $12::timestamptz),
        $13,
        now()
      )
    `,
    [
      p.xUserId,
      p.handle,
      p.name,
      p.avatarUrl,
      p.followersCount,
      p.bio,
      p.accountCreatedAt,
      source?.name ?? null,
      source?.avatar_url ?? null,
      source?.followers_count ?? null,
      source?.bio ?? null,
      source?.account_created_at ?? null,
      preferStance ?? source?.stance ?? null,
    ]
  );
}

async function mergeDistinctIdentities(
  client: PoolClient,
  p: OauthCommunityProfile,
  byX: CommunityUserRow,
  byH: CommunityUserRow
): Promise<void> {
  const preferHandleStance = Boolean(byH.stance) && !Boolean(byX.stance);
  const preferStance = preferHandleStance ? byH.stance : byX.stance;
  await ensureRowAtOauthId(client, p, preferHandleStance ? byH : byX, preferStance);
  await reassignCommunityUserDependents(client, String(byH.x_user_id), p.xUserId);
  await client.query(`DELETE FROM community_users WHERE x_user_id = $1`, [byH.x_user_id]);
  await updateProfileByXUserId(client, p.xUserId, p, { stance: preferStance ?? null });
}

/**
 * Link or merge the OAuth identity into community_users inside an open transaction.
 */
export async function reconcileOauthCommunityUser(
  client: PoolClient,
  raw: OauthCommunityProfile
): Promise<void> {
  const p: OauthCommunityProfile = {
    ...raw,
    xUserId: String(raw.xUserId || "").trim(),
    handle: normHandle(raw.handle),
  };
  if (!p.xUserId || !p.handle) {
    throw new Error("oauth reconcile requires x_user_id and handle");
  }

  const byX = await fetchByXUserId(client, p.xUserId);
  const byH = await fetchByHandle(client, p.handle);

  if (byX && byH && String(byX.x_user_id) !== String(byH.x_user_id)) {
    await mergeDistinctIdentities(client, p, byX, byH);
    return;
  }

  if (byX) {
    await updateProfileByXUserId(client, p.xUserId, p);
    return;
  }

  if (byH) {
    const oldId = String(byH.x_user_id ?? "").trim();
    if (!oldId) {
      const updated = await client.query(
        `
          UPDATE community_users
          SET x_user_id = $1,
              handle = $2,
              name = COALESCE(NULLIF($3, ''), community_users.name),
              avatar_url = COALESCE(NULLIF($4, ''), community_users.avatar_url),
              followers_count = COALESCE(NULLIF($5, 0), community_users.followers_count),
              bio = CASE
                WHEN NULLIF($6, '') IS NOT NULL THEN $6
                ELSE community_users.bio
              END,
              account_created_at = COALESCE(community_users.account_created_at, $7::timestamptz),
              updated_at = now()
          WHERE lower(coalesce(handle, '')) = $2
            AND (x_user_id IS NULL OR x_user_id = '')
        `,
        [p.xUserId, p.handle, p.name, p.avatarUrl, p.followersCount, p.bio, p.accountCreatedAt]
      );
      if ((updated.rowCount ?? 0) === 0) {
        await insertNewUser(client, p);
      }
      return;
    }
    if (oldId === p.xUserId) {
      await updateProfileByXUserId(client, p.xUserId, p);
      return;
    }
    await ensureRowAtOauthId(client, p, byH, byH.stance);
    await reassignCommunityUserDependents(client, oldId, p.xUserId);
    await client.query(`DELETE FROM community_users WHERE x_user_id = $1`, [oldId]);
    await updateProfileByXUserId(client, p.xUserId, p, { stance: byH.stance ?? null });
    return;
  }

  await insertNewUser(client, p);
}
