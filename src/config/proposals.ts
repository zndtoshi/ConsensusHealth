/**
 * Canonical proposal (BIP) configuration for Consensus Health galaxies.
 * Shared conceptually with the server; keep IDs stable.
 */

export type ProposalId = "bip110" | "bip54" | "bip119";

export type ProposalVisualTheme = {
  /** CSS accent for header / travel */
  accent: string;
  accentSoft: string;
  nebulaFrom: string;
  nebulaTo: string;
  starTint: string;
  distantGlow: string;
};

export type ProposalConfig = {
  id: ProposalId;
  bipNumber: number;
  shortName: string;
  title: string;
  description: string;
  order: number;
  enabled: boolean;
  /** Public visitors only ever see this proposal. */
  publicDefault: boolean;
  visualTheme: ProposalVisualTheme;
  emptyMessage: string;
};

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
    visualTheme: {
      accent: "#f87171",
      accentSoft: "rgba(248, 113, 113, 0.35)",
      nebulaFrom: "rgba(127, 29, 29, 0.35)",
      nebulaTo: "rgba(15, 23, 42, 0.9)",
      starTint: "rgba(254, 202, 202, 0.55)",
      distantGlow: "rgba(239, 68, 68, 0.45)",
    },
    emptyMessage: "Be the first to map this consensus galaxy.",
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
    visualTheme: {
      accent: "#22d3ee",
      accentSoft: "rgba(34, 211, 238, 0.35)",
      nebulaFrom: "rgba(8, 145, 178, 0.32)",
      nebulaTo: "rgba(15, 23, 42, 0.92)",
      starTint: "rgba(165, 243, 252, 0.55)",
      distantGlow: "rgba(34, 211, 238, 0.45)",
    },
    emptyMessage: "Be the first to map this consensus galaxy.",
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
    visualTheme: {
      accent: "#a78bfa",
      accentSoft: "rgba(167, 139, 250, 0.35)",
      nebulaFrom: "rgba(91, 33, 182, 0.32)",
      nebulaTo: "rgba(15, 23, 42, 0.92)",
      starTint: "rgba(221, 214, 254, 0.55)",
      distantGlow: "rgba(167, 139, 250, 0.45)",
    },
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
];

export const DEFAULT_PROPOSAL_ID: ProposalId = "bip110";

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

/** Accepts "bip110", "110", "BIP-110". Falls back to BIP110 when invalid. */
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

export function adjacentProposals(id: ProposalId): { prev: ProposalConfig; next: ProposalConfig; current: ProposalConfig } {
  const list = listEnabledProposals();
  const idx = Math.max(0, list.findIndex((p) => p.id === id));
  const current = list[idx]!;
  const prev = list[(idx - 1 + list.length) % list.length]!;
  const next = list[(idx + 1) % list.length]!;
  return { prev, next, current };
}

export function proposalPath(id: ProposalId): string {
  const p = getProposalById(id);
  return `/bip/${p?.bipNumber ?? 110}`;
}

export function parseProposalFromPathname(pathname: string): ProposalId {
  const m = String(pathname || "").match(/\/bip\/(\d+)/i);
  if (m) return resolveProposalId(m[1]);
  return DEFAULT_PROPOSAL_ID;
}
