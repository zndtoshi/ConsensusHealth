/**
 * Frontend proposal types + helpers.
 * Runtime catalog comes from GET /api/proposals (DB-authoritative).
 * FALLBACK_PROPOSALS is only used before the catalog loads / offline.
 */

import { getTheme, resolveThemeKey, type ProposalThemeKey, type ProposalVisualTheme } from "./proposalThemes";

export type ProposalId = string;

export type ProposalConfig = {
  id: ProposalId;
  bipNumber: number;
  shortName: string;
  title: string;
  description: string;
  order: number;
  enabled: boolean;
  adminOnly: boolean;
  themeKey: ProposalThemeKey;
  visualTheme: ProposalVisualTheme;
  emptyMessage: string;
};

export const DEFAULT_PROPOSAL_ID: ProposalId = "bip110";

/** Offline / pre-fetch fallback — keep in sync with server seed catalog. */
export const FALLBACK_PROPOSALS: ProposalConfig[] = [
  {
    id: "bip110",
    bipNumber: 110,
    shortName: "BIP110",
    title: "BIP-110",
    description: "Reduced Data Temporary Softfork",
    order: 0,
    enabled: true,
    adminOnly: false,
    themeKey: "nebula-red",
    visualTheme: getTheme("nebula-red"),
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
  {
    id: "bip54",
    bipNumber: 54,
    shortName: "BIP54",
    title: "BIP-54",
    description: "Consensus Cleanup — fixes long-standing consensus vulnerabilities",
    order: 1,
    enabled: true,
    adminOnly: true,
    themeKey: "nebula-cyan",
    visualTheme: getTheme("nebula-cyan"),
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
  {
    id: "bip448",
    bipNumber: 448,
    shortName: "BIP448",
    title: "BIP-448",
    description: "Taproot-native rebindable transactions for scalable payment protocols",
    order: 2,
    enabled: true,
    adminOnly: true,
    themeKey: "nebula-violet",
    visualTheme: getTheme("nebula-violet"),
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
];

/** @deprecated Use FALLBACK_PROPOSALS or fetched catalog. */
export const PROPOSALS = FALLBACK_PROPOSALS;

export type ProposalApiItem = {
  id: string;
  slug?: string;
  bip_number: number;
  short_name: string;
  title: string;
  description: string;
  order: number;
  admin_only: boolean;
  theme_key: string;
  empty_message: string;
};

export function mapApiProposal(item: ProposalApiItem): ProposalConfig {
  const themeKey = resolveThemeKey(item.theme_key);
  return {
    id: String(item.id),
    bipNumber: Number(item.bip_number) || 0,
    shortName: String(item.short_name || item.title || item.id),
    title: String(item.title || item.short_name || item.id),
    description: String(item.description || ""),
    order: Number(item.order) || 0,
    enabled: true,
    adminOnly: Boolean(item.admin_only),
    themeKey,
    visualTheme: getTheme(themeKey),
    emptyMessage: String(item.empty_message || "Be the first to map this consensus galaxy."),
  };
}

export function getProposalById(id: unknown, catalog: ProposalConfig[] = FALLBACK_PROPOSALS): ProposalConfig | null {
  const key = String(id ?? "")
    .trim()
    .toLowerCase();
  return catalog.find((p) => p.id === key) ?? null;
}

export function getProposalByBipNumber(n: unknown, catalog: ProposalConfig[] = FALLBACK_PROPOSALS): ProposalConfig | null {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return catalog.find((p) => p.bipNumber === Math.trunc(num)) ?? null;
}

export function resolveProposalId(
  raw: unknown,
  catalog: ProposalConfig[] = FALLBACK_PROPOSALS,
  fallback: ProposalId = DEFAULT_PROPOSAL_ID
): ProposalId {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^bip-?/, "");
  if (!s) return fallback;
  const asId = getProposalById(`bip${s}`, catalog);
  if (asId) return asId.id;
  const asNum = getProposalByBipNumber(s, catalog);
  if (asNum) return asNum.id;
  return fallback;
}

export function listEnabledProposals(catalog: ProposalConfig[] = FALLBACK_PROPOSALS): ProposalConfig[] {
  return [...catalog].filter((p) => p.enabled).sort((a, b) => a.order - b.order);
}

export function adjacentProposals(
  id: ProposalId,
  catalog: ProposalConfig[] = FALLBACK_PROPOSALS
): { prev: ProposalConfig; next: ProposalConfig; current: ProposalConfig } {
  const list = listEnabledProposals(catalog);
  const idx = Math.max(0, list.findIndex((p) => p.id === id));
  const current = list[idx] || list[0]!;
  const prev = list[(idx - 1 + list.length) % list.length]!;
  const next = list[(idx + 1) % list.length]!;
  return { prev, next, current };
}

export function proposalPath(id: ProposalId, catalog: ProposalConfig[] = FALLBACK_PROPOSALS): string {
  const p = getProposalById(id, catalog);
  return `/bip/${p?.bipNumber ?? 110}`;
}

export function parseProposalFromPathname(
  pathname: string,
  catalog: ProposalConfig[] = FALLBACK_PROPOSALS
): ProposalId {
  const m = String(pathname || "").match(/\/bip\/(\d+)/i);
  if (m) return resolveProposalId(m[1], catalog);
  return DEFAULT_PROPOSAL_ID;
}
