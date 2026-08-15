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
import { strictNormalizedStance } from "./stanceChoice";
import { STANCE_COLORS, STANCE_LABELS, type StanceKey } from "./stanceColors";

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

export type OverviewPersonalStanceView = {
  kind: "hidden" | "chosen" | "not_chosen" | "no_recorded";
  /** Full line for visible + accessible text; null when logged out. */
  text: string | null;
  stance: StanceKey | null;
  /** Colored value word when kind === "chosen". */
  valueLabel: string | null;
  valueColor: string | null;
};

/**
 * Personalized "Your stance" row for an overview card from `/api/me` proposal_stances.
 * Does not affect public aggregates. Malformed values are treated as no stance.
 */
export function resolveOverviewPersonalStance(input: {
  authenticated: boolean;
  completed: boolean;
  rawStance: unknown;
}): OverviewPersonalStanceView {
  if (!input.authenticated) {
    return {
      kind: "hidden",
      text: null,
      stance: null,
      valueLabel: null,
      valueColor: null,
    };
  }
  const stance = strictNormalizedStance(input.rawStance);
  if (stance) {
    const valueLabel = STANCE_LABELS[stance];
    const valueColor =
      stance === "neutral" ? "rgba(226, 232, 240, 0.92)" : STANCE_COLORS[stance];
    return {
      kind: "chosen",
      text: `Your stance: ${valueLabel}`,
      stance,
      valueLabel,
      valueColor,
    };
  }
  if (input.completed) {
    return {
      kind: "no_recorded",
      text: "Your stance: No recorded stance",
      stance: null,
      valueLabel: "No recorded stance",
      valueColor: null,
    };
  }
  return {
    kind: "not_chosen",
    text: "Your stance: Not chosen",
    stance: null,
    valueLabel: "Not chosen",
    valueColor: null,
  };
}

/** Read a single proposal stance from the `/api/me` proposal_stances map. */
export function readMeProposalStance(
  proposalStances: Record<string, unknown> | null | undefined,
  proposalId: string
): unknown {
  if (!proposalStances || typeof proposalStances !== "object") return null;
  const id = String(proposalId || "").trim();
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(proposalStances, id)) {
    return proposalStances[id];
  }
  return null;
}
