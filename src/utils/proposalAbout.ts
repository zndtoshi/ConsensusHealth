/**
 * Compact “About BIP…” copy for the stance chooser.
 * Always derived from the proposal catalog — never hard-coded by card mode.
 */

import { proposalGithubUrl, type ProposalConfig, type ProposalStatus } from "../config/proposals";

export type ProposalAboutInfo = {
  id: string;
  shortName: string;
  title: string;
  description: string;
  status: ProposalStatus;
  statusLabel: string;
  statusDetail: string;
  githubUrl: string | null;
  heading: string;
};

export function proposalStatusLabel(status: ProposalStatus | string | null | undefined): string {
  const key = String(status ?? "")
    .trim()
    .toLowerCase();
  if (key === "final") return "Final snapshot";
  if (key === "draft") return "Draft";
  return "Ongoing";
}

export function proposalStatusDetail(status: ProposalStatus | string | null | undefined): string {
  const key = String(status ?? "")
    .trim()
    .toLowerCase();
  if (key === "final") {
    return "This proposal is a final, read-only historical snapshot. Positions are locked.";
  }
  if (key === "draft") {
    return "This proposal is still in draft. Positions may change as the text evolves.";
  }
  return "This proposal is ongoing. Positions are self-reported and can be updated.";
}

/** Build structured about-info from an active catalog proposal. */
export function buildProposalAbout(
  proposal: Pick<ProposalConfig, "id" | "shortName" | "title" | "description" | "status"> | null | undefined
): ProposalAboutInfo | null {
  if (!proposal) return null;
  const id = String(proposal.id || "").trim();
  if (!id) return null;
  const title = String(proposal.title || proposal.shortName || id).trim();
  const shortName = String(proposal.shortName || title).trim();
  const description = String(proposal.description || "").trim();
  const status = (String(proposal.status || "ongoing").trim().toLowerCase() || "ongoing") as ProposalStatus;
  return {
    id,
    shortName,
    title,
    description,
    status,
    statusLabel: proposalStatusLabel(status),
    statusDetail: proposalStatusDetail(status),
    githubUrl: proposalGithubUrl(id),
    heading: `About ${title}`,
  };
}
