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

/** Build proposal-scoped stats SQL. BIP110 uses legacy tables for public parity. */
export function buildStatsSql(proposalId: ProposalId): StatsQueryBundle {
  if (proposalId === DEFAULT_PROPOSAL_ID) {
    return {
      params: [],
      aggSql: `
        WITH normalized AS (
          SELECT
            CASE
              WHEN lower(coalesce(stance, '')) = 'support' THEN 'approve'
              WHEN lower(coalesce(stance, '')) IN ('against', 'neutral', 'approve') THEN lower(stance)
              ELSE NULL
            END AS stance_norm,
            COALESCE(followers_count, 0) AS followers_count
          FROM community_users
        )
        SELECT
          COUNT(*) FILTER (WHERE stance_norm IS NOT NULL)::int AS total_users_with_stance,
          COUNT(*) FILTER (WHERE stance_norm = 'against')::int AS against_count,
          COUNT(*) FILTER (WHERE stance_norm = 'neutral')::int AS neutral_count,
          COUNT(*) FILTER (WHERE stance_norm = 'approve')::int AS approve_count,
          COALESCE(SUM(followers_count) FILTER (WHERE stance_norm = 'against'), 0)::bigint AS against_followers_total,
          COALESCE(SUM(followers_count) FILTER (WHERE stance_norm = 'neutral'), 0)::bigint AS neutral_followers_total,
          COALESCE(SUM(followers_count) FILTER (WHERE stance_norm = 'approve'), 0)::bigint AS approve_followers_total,
          COALESCE(ROUND(AVG(followers_count) FILTER (WHERE stance_norm = 'against')), 0)::int AS against_followers_avg,
          COALESCE(ROUND(AVG(followers_count) FILTER (WHERE stance_norm = 'neutral')), 0)::int AS neutral_followers_avg,
          COALESCE(ROUND(AVG(followers_count) FILTER (WHERE stance_norm = 'approve')), 0)::int AS approve_followers_avg
        FROM normalized
      `,
      topSql: `
        WITH ranked AS (
          SELECT
            handle,
            followers_count,
            CASE
              WHEN lower(coalesce(stance, '')) = 'support' THEN 'approve'
              WHEN lower(coalesce(stance, '')) IN ('against', 'neutral', 'approve') THEN lower(stance)
              ELSE NULL
            END AS stance_norm,
            ROW_NUMBER() OVER (
              PARTITION BY
                CASE
                  WHEN lower(coalesce(stance, '')) = 'support' THEN 'approve'
                  WHEN lower(coalesce(stance, '')) IN ('against', 'neutral', 'approve') THEN lower(stance)
                  ELSE NULL
                END
              ORDER BY COALESCE(followers_count, 0) DESC, handle ASC
            ) AS rn
          FROM community_users
        )
        SELECT stance_norm, handle, followers_count
        FROM ranked
        WHERE stance_norm IN ('against', 'neutral', 'approve') AND rn = 1
      `,
      changedEverSql: `
        SELECT COUNT(DISTINCT x_user_id)::int AS changed_ever
        FROM stance_history
        WHERE previous_stance IS DISTINCT FROM new_stance
      `,
      changes7dSql: `
        SELECT COUNT(*)::int AS changes_last_7d
        FROM stance_history
        WHERE changed_at >= now() - interval '7 days'
          AND previous_stance IS DISTINCT FROM new_stance
      `,
      totalChangesSql: `
        SELECT COUNT(*)::int AS total_changes
        FROM stance_history
        WHERE previous_stance IS DISTINCT FROM new_stance
      `,
      transitionSql: `
        SELECT previous_stance AS "from", new_stance AS "to", COUNT(*)::int AS count
        FROM stance_history
        GROUP BY previous_stance, new_stance
        HAVING COUNT(*) > 0
        ORDER BY count DESC, previous_stance NULLS FIRST, new_stance
      `,
      flowsSql: `
        WITH norm AS (
          SELECT
            CASE
              WHEN lower(coalesce(previous_stance, '')) = 'support' THEN 'approve'
              WHEN lower(coalesce(previous_stance, '')) IN ('against', 'neutral', 'approve') THEN lower(previous_stance)
              ELSE NULL
            END AS from_norm,
            CASE
              WHEN lower(coalesce(new_stance, '')) = 'support' THEN 'approve'
              WHEN lower(coalesce(new_stance, '')) IN ('against', 'neutral', 'approve') THEN lower(new_stance)
              ELSE NULL
            END AS to_norm
          FROM stance_history
          WHERE changed_at >= now() - interval '7 days'
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
  const sql = buildStatsSql(proposalId);
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
