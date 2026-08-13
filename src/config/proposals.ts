/**
 * Frontend proposal types + helpers.
 * Runtime catalog comes from GET /api/proposals (DB-authoritative).
 * FALLBACK_PROPOSALS is only used before the catalog loads / offline.
 */

import { getTheme, resolveThemeKey, type ProposalThemeKey, type ProposalVisualTheme } from "./proposalThemes";

export type ProposalId = string;

export type ProposalStatus = "final" | "ongoing" | "draft";

export type ProposalConfig = {
  id: ProposalId;
  bipNumber: number;
  shortName: string;
  title: string;
  description: string;
  order: number;
  enabled: boolean;
  adminOnly: boolean;
  status: ProposalStatus;
  themeKey: ProposalThemeKey;
  visualTheme: ProposalVisualTheme;
  emptyMessage: string;
};

export const DEFAULT_PROPOSAL_ID: ProposalId = "bip110";

const PROPOSAL_GITHUB_URLS: Record<string, string> = {
  bip54: "https://github.com/bitcoin/bips/blob/master/bip-0054.md",
  bip110: "https://github.com/bitcoin/bips/blob/master/bip-0110.mediawiki",
  bip448: "https://github.com/bitcoin/bips/blob/master/bip-0448.md",
  bip460:
    "https://github.com/fjahr/bips/blob/cf0d4f2142cd0504b16e86739167b1f7ab9a3a06/bip-XXXX.mediawiki",
};

export function proposalGithubUrl(id: unknown): string | null {
  const key = String(id ?? "").trim().toLowerCase();
  return PROPOSAL_GITHUB_URLS[key] ?? null;
}

export function resolveProposalStatus(raw: unknown): ProposalStatus {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (key === "final" || key === "ongoing" || key === "draft") return key;
  return "ongoing";
}

export function isFinalProposal(proposal: { status?: unknown } | null | undefined): boolean {
  return resolveProposalStatus(proposal?.status) === "final";
}

export function isOngoingProposal(proposal: { status?: unknown } | null | undefined): boolean {
  return resolveProposalStatus(proposal?.status) === "ongoing";
}

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
    status: "final",
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
    adminOnly: false,
    status: "ongoing",
    themeKey: "nebula-cyan",
    visualTheme: getTheme("nebula-cyan"),
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
  {
    id: "bip448",
    bipNumber: 448,
    shortName: "BIP448",
    title: "BIP-448",
    description:
      "Taproot-native rebindable transactions and covenant building blocks for scalable payment protocols",
    order: 2,
    enabled: true,
    adminOnly: false,
    status: "ongoing",
    themeKey: "nebula-violet",
    visualTheme: getTheme("nebula-violet"),
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
  {
    id: "bip460",
    bipNumber: 460,
    shortName: "BIP460",
    title: "BIP-460",
    description:
      "Cross-Input Signature Aggregation — improves transaction efficiency and can strengthen privacy by aggregating signatures across inputs",
    order: 3,
    enabled: true,
    adminOnly: false,
    status: "ongoing",
    themeKey: "nebula-yellow",
    visualTheme: getTheme("nebula-yellow"),
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
  status?: string;
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
    status: resolveProposalStatus(item.status),
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

/**
 * Inactive proposals for distant-galaxy display, in stable catalog order.
 * Layout poses are keyed by proposal ID (not list index), so hiding the active
 * BIP never reshuffles the remaining galaxies.
 */
/** Max inactive distant galaxies shown in the background (dropdown stays full). */
export const DISTANT_GALAXIES_VISIBLE_LIMIT = 4;

export function selectDistantProposals(
  activeProposalId: unknown,
  catalog: ProposalConfig[] = FALLBACK_PROPOSALS,
  limit = DISTANT_GALAXIES_VISIBLE_LIMIT
): ProposalConfig[] {
  const list = listEnabledProposals(catalog);
  if (list.length <= 1) return [];
  const active = String(activeProposalId ?? "")
    .trim()
    .toLowerCase();
  const others = list.filter((p) => p.id !== active);
  const requested = Math.trunc(Number(limit));
  const softCap = Number.isFinite(requested) && requested > 0 ? requested : DISTANT_GALAXIES_VISIBLE_LIMIT;
  const cap = Math.max(0, Math.min(softCap, DISTANT_GALAXIES_VISIBLE_LIMIT, others.length));
  return others.slice(0, cap);
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

export function statisticsActionLabel(proposal: { status?: unknown; title?: string } | null | undefined): string {
  return isFinalProposal(proposal) ? "Final Results" : "Statistics";
}

export function statisticsModalCopy(proposal: { status?: unknown; title?: string } | null | undefined): {
  heading: string;
  subtitle: string;
} {
  const title = String(proposal?.title || "Proposal").trim() || "Proposal";
  if (isFinalProposal(proposal)) {
    return {
      heading: `${title} Final Results`,
      subtitle: "Final positions · preserved historical snapshot",
    };
  }
  return {
    heading: `${title} Statistics`,
    subtitle: "Current positions · ongoing proposal",
  };
}
