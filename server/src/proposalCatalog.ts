/**
 * Server proposal catalog (duplicated from frontend config to avoid cross-package import issues).
 * Keep IDs and bip numbers in sync with src/config/proposals.ts.
 */

export type ProposalId = "bip110" | "bip54" | "bip119";

export type ProposalConfig = {
  id: ProposalId;
  bipNumber: number;
  shortName: string;
  title: string;
  description: string;
  order: number;
  enabled: boolean;
  publicDefault: boolean;
};

export const DEFAULT_PROPOSAL_ID: ProposalId = "bip110";

export const PROPOSALS: ProposalConfig[] = [
  {
    id: "bip110",
    bipNumber: 110,
    shortName: "BIP110",
    title: "BIP-110",
    description: "Consensus Health consensus map for BIP-110.",
    order: 0,
    enabled: true,
    publicDefault: true,
  },
  {
    id: "bip54",
    bipNumber: 54,
    shortName: "BIP54",
    title: "BIP-54",
    description: "Cleanup and consensus order — unexplored until the first vote.",
    order: 1,
    enabled: true,
    publicDefault: false,
  },
  {
    id: "bip119",
    bipNumber: 119,
    shortName: "BIP119",
    title: "BIP-119",
    description: "Covenant / template consensus — waiting for explorers.",
    order: 2,
    enabled: true,
    publicDefault: false,
  },
];

const BY_ID = new Map(PROPOSALS.map((p) => [p.id, p]));
const BY_NUMBER = new Map(PROPOSALS.map((p) => [p.bipNumber, p]));

export function getProposalById(id: unknown): ProposalConfig | null {
  const key = String(id ?? "")
    .trim()
    .toLowerCase();
  return BY_ID.get(key as ProposalId) ?? null;
}

export function getProposalByBipNumber(n: unknown): ProposalConfig | null {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return BY_NUMBER.get(Math.trunc(num)) ?? null;
}

export function resolveProposalId(raw: unknown, fallback: ProposalId = DEFAULT_PROPOSAL_ID): ProposalId {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^bip-?/, "");
  if (!s) return fallback;
  const asId = getProposalById(`bip${s}`);
  if (asId) return asId.id;
  const asNum = getProposalByBipNumber(s);
  if (asNum) return asNum.id;
  return fallback;
}

export function listEnabledProposals(): ProposalConfig[] {
  return [...PROPOSALS].filter((p) => p.enabled).sort((a, b) => a.order - b.order);
}
