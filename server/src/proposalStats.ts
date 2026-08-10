/**
 * Proposal-scoped statistics SQL.
 * Canonical source: user_proposal_stances + user_proposal_stance_history for ALL proposals including BIP110.
 */

import type { Pool } from "pg";
import { DEFAULT_PROPOSAL_ID, type ProposalId } from "./proposalCatalog.js";

export type StatsQueryBundle = {
  aggSql: string;
  topSql: string;
  changedEverSql: string;
  changes7dSql: string;
  totalChangesSql: string;
  transitionSql: string;
  flowsSql: string;
  params: string[];
};

/** Build proposal-scoped stats SQL (identical shape for every BIP). */
export function buildStatsSql(proposalId: ProposalId): StatsQueryBundle {
  return {
    params: [proposalId],
    aggSql: `
      SELECT
        COUNT(*)::int AS total_users_with_stance,
        COUNT(*) FILTER (WHERE ups.stance = 'against')::int AS against_count,
        COUNT(*) FILTER (WHERE ups.stance = 'neutral')::int AS neutral_count,
        COUNT(*) FILTER (WHERE ups.stance = 'approve')::int AS approve_count,
        COALESCE(SUM(COALESCE(cu.followers_count, 0)) FILTER (WHERE ups.stance = 'against'), 0)::bigint AS against_followers_total,
        COALESCE(SUM(COALESCE(cu.followers_count, 0)) FILTER (WHERE ups.stance = 'neutral'), 0)::bigint AS neutral_followers_total,
        COALESCE(SUM(COALESCE(cu.followers_count, 0)) FILTER (WHERE ups.stance = 'approve'), 0)::bigint AS approve_followers_total,
        COALESCE(ROUND(AVG(COALESCE(cu.followers_count, 0)) FILTER (WHERE ups.stance = 'against')), 0)::int AS against_followers_avg,
        COALESCE(ROUND(AVG(COALESCE(cu.followers_count, 0)) FILTER (WHERE ups.stance = 'neutral')), 0)::int AS neutral_followers_avg,
        COALESCE(ROUND(AVG(COALESCE(cu.followers_count, 0)) FILTER (WHERE ups.stance = 'approve')), 0)::int AS approve_followers_avg
      FROM user_proposal_stances ups
      INNER JOIN community_users cu ON cu.x_user_id = ups.x_user_id
      WHERE ups.proposal_id = $1
    `,
    topSql: `
      WITH ranked AS (
        SELECT
          cu.handle,
          cu.followers_count,
          ups.stance AS stance_norm,
          ROW_NUMBER() OVER (
            PARTITION BY ups.stance
            ORDER BY COALESCE(cu.followers_count, 0) DESC, cu.handle ASC
          ) AS rn
        FROM user_proposal_stances ups
        INNER JOIN community_users cu ON cu.x_user_id = ups.x_user_id
        WHERE ups.proposal_id = $1
      )
      SELECT stance_norm, handle, followers_count
      FROM ranked
      WHERE stance_norm IN ('against', 'neutral', 'approve') AND rn = 1
    `,
    changedEverSql: `
      SELECT COUNT(DISTINCT x_user_id)::int AS changed_ever
      FROM user_proposal_stance_history
      WHERE proposal_id = $1
        AND previous_stance IS DISTINCT FROM new_stance
    `,
    changes7dSql: `
      SELECT COUNT(*)::int AS changes_last_7d
      FROM user_proposal_stance_history
      WHERE proposal_id = $1
        AND changed_at >= now() - interval '7 days'
        AND previous_stance IS DISTINCT FROM new_stance
    `,
    totalChangesSql: `
      SELECT COUNT(*)::int AS total_changes
      FROM user_proposal_stance_history
      WHERE proposal_id = $1
        AND previous_stance IS DISTINCT FROM new_stance
    `,
    transitionSql: `
      SELECT previous_stance AS "from", new_stance AS "to", COUNT(*)::int AS count
      FROM user_proposal_stance_history
      WHERE proposal_id = $1
      GROUP BY previous_stance, new_stance
      HAVING COUNT(*) > 0
      ORDER BY count DESC, previous_stance NULLS FIRST, new_stance
    `,
    flowsSql: `
      WITH norm AS (
        SELECT
          previous_stance AS from_norm,
          new_stance AS to_norm
        FROM user_proposal_stance_history
        WHERE proposal_id = $1
          AND changed_at >= now() - interval '7 days'
      )
      SELECT from_norm AS "from", to_norm AS "to", COUNT(*)::int AS count
      FROM norm
      WHERE to_norm IN ('against', 'neutral', 'approve')
      GROUP BY from_norm, to_norm
      HAVING COUNT(*) > 0
      ORDER BY count DESC, from_norm NULLS FIRST, to_norm
    `,
  };
}

export async function runStatsQueries(pool: Pool, proposalId: ProposalId) {
  const sql = buildStatsSql(proposalId || DEFAULT_PROPOSAL_ID);
  const p = sql.params;
  return Promise.all([
    pool.query(sql.aggSql, p),
    pool.query(sql.topSql, p),
    pool.query(sql.changedEverSql, p),
    pool.query(sql.changes7dSql, p),
    pool.query(sql.totalChangesSql, p),
    pool.query(sql.transitionSql, p),
    pool.query(sql.flowsSql, p),
  ]);
}
