/**
 * Consensus Overview route + catalog helpers (public landing on `/`).
 */

import {
  isFinalProposal,
  isOngoingProposal,
  listEnabledProposals,
  type ProposalConfig,
  type ProposalId,
} from "../config/proposals";

export const OVERVIEW_PATH = "/";

export function isOverviewPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  return path === "/" || path === "";
}

/** Ongoing public proposals for the overview primary section (catalog order). */
export function listOverviewOngoingProposals(
  catalog: ProposalConfig[]
): ProposalConfig[] {
  return listEnabledProposals(catalog).filter(
    (p) => isOngoingProposal(p) && !p.adminOnly
  );
}

/** Final/archived public proposals for the completed section. */
export function listOverviewCompletedProposals(
  catalog: ProposalConfig[]
): ProposalConfig[] {
  return listEnabledProposals(catalog).filter(
    (p) => isFinalProposal(p) && !p.adminOnly
  );
}

export type OverviewProposalStats = {
  proposalId: ProposalId;
  totalUsersWithStance: number;
  counts: { against: number; neutral: number; approve: number };
  status: "ok" | "loading" | "error" | "empty";
  error?: string;
};

export type OverviewAggregates = {
  /** Distinct accounts with ≥1 stance across ongoing proposals only. */
  uniqueParticipants: number;
  /** Sum of per-proposal stance rows across ongoing proposals. */
  stanceSelections: number;
  ongoingCount: number;
};

/** Wire shape from GET /api/consensus-overview (snake_case). */
export type ConsensusOverviewPayload = {
  generated_at: string;
  ongoing_proposal_ids: string[];
  completed_proposal_ids: string[];
  proposals: Array<{
    proposal_id: string;
    total_users_with_stance: number;
    against: number;
    neutral: number;
    approve: number;
  }>;
  aggregates: {
    unique_participants: number;
    stance_selections: number;
  };
};

export function mapOverviewPayloadToStats(
  payload: ConsensusOverviewPayload,
  proposalId: string
): OverviewProposalStats {
  const row = payload.proposals.find((p) => p.proposal_id === proposalId);
  if (!row) {
    return {
      proposalId: proposalId as ProposalId,
      totalUsersWithStance: 0,
      counts: { against: 0, neutral: 0, approve: 0 },
      status: "empty",
    };
  }
  return {
    proposalId: proposalId as ProposalId,
    totalUsersWithStance: Number(row.total_users_with_stance) || 0,
    counts: {
      against: Number(row.against) || 0,
      neutral: Number(row.neutral) || 0,
      approve: Number(row.approve) || 0,
    },
    status: "ok",
  };
}

export function sumStanceSelections(cards: OverviewProposalStats[]): number {
  return cards.reduce((n, c) => n + (c.totalUsersWithStance || 0), 0);
}

/**
 * Build a proportional mini-galaxy sample without inventing support for a
 * stance whose canonical count is zero.
 */
export function buildStanceStarKeys(
  counts: { against?: number; neutral?: number; approve?: number },
  sampleSize = 18
): Array<"against" | "neutral" | "approve"> {
  const against = Math.max(0, Number(counts?.against) || 0);
  const neutral = Math.max(0, Number(counts?.neutral) || 0);
  const approve = Math.max(0, Number(counts?.approve) || 0);
  const total = against + neutral + approve;
  const size = Math.max(0, Math.trunc(Number(sampleSize) || 0));
  if (total <= 0 || size <= 0) return [];

  return Array.from({ length: size }, (_, index) => {
    const midpoint = ((index + 0.5) / size) * total;
    if (midpoint <= against) return "against";
    if (midpoint <= against + neutral) return "neutral";
    return "approve";
  });
}

export function overviewHeading(ongoingCount: number): string {
  const n = Math.max(0, Math.trunc(Number(ongoingCount) || 0));
  const noun = n === 1 ? "proposal" : "proposals";
  return `ACTIVE CONSENSUS — ${n} ongoing ${noun}`;
}
