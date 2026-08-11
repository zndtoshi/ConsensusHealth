import {
  adjacentProposals,
  DEFAULT_PROPOSAL_ID,
  listEnabledProposals,
  parseProposalFromPathname,
  proposalPath,
  resolveProposalId,
  type ProposalConfig,
  type ProposalId,
} from "../config/proposals";

export function readProposalIdFromLocation(catalog?: ProposalConfig[]): ProposalId {
  if (typeof window === "undefined") return DEFAULT_PROPOSAL_ID;
  return parseProposalFromPathname(window.location.pathname, catalog);
}

export function writeProposalIdToLocation(
  id: ProposalId,
  replace = false,
  catalog?: ProposalConfig[]
): void {
  if (typeof window === "undefined") return;
  const next = proposalPath(id, catalog);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const target = `${next}${window.location.search}${window.location.hash}`;
  if (current === target) return;
  if (replace) window.history.replaceState({ proposalId: id }, "", target);
  else window.history.pushState({ proposalId: id }, "", target);
}

export function getAdjacent(id: ProposalId, catalog?: ProposalConfig[]) {
  return adjacentProposals(id, catalog);
}

export function normalizeIncomingProposalId(
  raw: unknown,
  _allowMultiGalaxy: boolean,
  catalog?: ProposalConfig[]
): ProposalId {
  const list = listEnabledProposals(catalog);
  const id = resolveProposalId(raw, list, DEFAULT_PROPOSAL_ID);
  if (list.some((p) => p.id === id)) return id;
  return list[0]?.id || DEFAULT_PROPOSAL_ID;
}
