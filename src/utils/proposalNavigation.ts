import {
  adjacentProposals,
  DEFAULT_PROPOSAL_ID,
  listEnabledProposals,
  parseProposalFromPathname,
  proposalPath,
  resolveProposalId,
  type ProposalId,
} from "../config/proposals";

export type ActiveProposalState = {
  proposalId: ProposalId;
  setProposalId: (id: ProposalId, opts?: { replace?: boolean }) => void;
  navigateRelative: (delta: -1 | 1) => void;
};

/** Sync active proposal with /bip/:number URL (History API, no full reload). */
export function readProposalIdFromLocation(): ProposalId {
  if (typeof window === "undefined") return DEFAULT_PROPOSAL_ID;
  return parseProposalFromPathname(window.location.pathname);
}

export function writeProposalIdToLocation(id: ProposalId, replace = false): void {
  if (typeof window === "undefined") return;
  const next = proposalPath(id);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const target = `${next}${window.location.search}${window.location.hash}`;
  if (current === target) return;
  if (replace) window.history.replaceState({ proposalId: id }, "", target);
  else window.history.pushState({ proposalId: id }, "", target);
}

export function getAdjacent(id: ProposalId) {
  return adjacentProposals(id);
}

export function getPublicOrAdminProposals(adminGalaxies: boolean) {
  const all = listEnabledProposals();
  return adminGalaxies ? all : all.filter((p) => p.publicDefault);
}

export function normalizeIncomingProposalId(raw: unknown, adminGalaxies: boolean): ProposalId {
  const id = resolveProposalId(raw, DEFAULT_PROPOSAL_ID);
  if (adminGalaxies) return id;
  return DEFAULT_PROPOSAL_ID;
}
