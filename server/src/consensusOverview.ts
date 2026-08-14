/**
 * Public Consensus Overview aggregates from canonical user_proposal_stances.
 */

import type { Pool } from "pg";

export type OverviewProposalAggregate = {
  proposal_id: string;
  total_users_with_stance: number;
  against: number;
  neutral: number;
  approve: number;
};

export type ConsensusOverviewPayload = {
  generated_at: string;
  ongoing_proposal_ids: string[];
  completed_proposal_ids: string[];
  proposals: OverviewProposalAggregate[];
  aggregates: {
    unique_participants: number;
    stance_selections: number;
  };
};

/**
 * Build overview stats for the given public proposal ids.
 * `ongoingIds` drive unique_participants / stance_selections aggregates.
 */
export async function queryConsensusOverview(
  pool: Pool,
  opts: { ongoingIds: string[]; completedIds: string[] }
): Promise<ConsensusOverviewPayload> {
  const ongoingIds = [...new Set(opts.ongoingIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const completedIds = [
    ...new Set(opts.completedIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ];
  const allIds = [...new Set([...ongoingIds, ...completedIds])];

  const proposals: OverviewProposalAggregate[] = [];
  if (allIds.length) {
    const res = await pool.query(
      `
        SELECT
          ups.proposal_id,
          COUNT(*)::int AS total_users_with_stance,
          COUNT(*) FILTER (WHERE ups.stance = 'against')::int AS against,
          COUNT(*) FILTER (WHERE ups.stance = 'neutral')::int AS neutral,
          COUNT(*) FILTER (WHERE ups.stance = 'approve')::int AS approve
        FROM user_proposal_stances ups
        WHERE ups.proposal_id = ANY($1::text[])
        GROUP BY ups.proposal_id
      `,
      [allIds]
    );
    const byId = new Map(
      res.rows.map((r) => [
        String(r.proposal_id),
        {
          proposal_id: String(r.proposal_id),
          total_users_with_stance: Number(r.total_users_with_stance) || 0,
          against: Number(r.against) || 0,
          neutral: Number(r.neutral) || 0,
          approve: Number(r.approve) || 0,
        } satisfies OverviewProposalAggregate,
      ])
    );
    for (const id of allIds) {
      proposals.push(
        byId.get(id) || {
          proposal_id: id,
          total_users_with_stance: 0,
          against: 0,
          neutral: 0,
          approve: 0,
        }
      );
    }
  }

  let uniqueParticipants = 0;
  let stanceSelections = 0;
  if (ongoingIds.length) {
    const uniq = await pool.query(
      `
        SELECT COUNT(DISTINCT ups.x_user_id)::int AS unique_participants,
               COUNT(*)::int AS stance_selections
        FROM user_proposal_stances ups
        WHERE ups.proposal_id = ANY($1::text[])
      `,
      [ongoingIds]
    );
    uniqueParticipants = Number(uniq.rows[0]?.unique_participants) || 0;
    stanceSelections = Number(uniq.rows[0]?.stance_selections) || 0;
  }

  return {
    generated_at: new Date().toISOString(),
    ongoing_proposal_ids: ongoingIds,
    completed_proposal_ids: completedIds,
    proposals,
    aggregates: {
      unique_participants: uniqueParticipants,
      stance_selections: stanceSelections,
    },
  };
}
