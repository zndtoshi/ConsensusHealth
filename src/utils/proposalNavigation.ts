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
import { isOverviewPath, OVERVIEW_PATH } from "./consensusOverview";

export function readProposalIdFromLocation(catalog?: ProposalConfig[]): ProposalId | null {
  if (typeof window === "undefined") return DEFAULT_PROPOSAL_ID;
  return parseProposalFromPathname(window.location.pathname, catalog);
}

export function readShowOverviewFromLocation(): boolean {
  if (typeof window === "undefined") return true;
  return isOverviewPath(window.location.pathname);
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

export function writeOverviewToLocation(replace = false): void {
  if (typeof window === "undefined") return;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const target = `${OVERVIEW_PATH}${window.location.search}${window.location.hash}`;
  if (current === target) return;
  if (replace) window.history.replaceState({ overview: true }, "", target);
  else window.history.pushState({ overview: true }, "", target);
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
