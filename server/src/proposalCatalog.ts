/**
 * Server proposal catalog seed + theme keys.
 * Database `proposals` table is authoritative at runtime; this seed syncs on migrate.
 * Frontend themes resolve via validated theme_key only (no arbitrary CSS from DB).
 */

export type ProposalId = string;

export type ProposalThemeKey = "nebula-red" | "nebula-cyan" | "nebula-violet" | "nebula-yellow";

/** Validated proposal lifecycle — never apply arbitrary DB strings to UI/access. */
export type ProposalStatus = "final" | "ongoing" | "draft";

export type ProposalSeedConfig = {
  id: ProposalId;
  bipNumber: number;
  shortName: string;
  title: string;
  description: string;
  order: number;
  enabled: boolean;
  /** When true, only privileged admin (zndtoshi) may access (draft/unpublished). */
  adminOnly: boolean;
  status: ProposalStatus;
  themeKey: ProposalThemeKey;
  emptyMessage: string;
};

export const DEFAULT_PROPOSAL_ID: ProposalId = "bip110";

/** Stable advisory-lock key for consensus-universe migrations (arbitrary app-specific int). */
export const CONSENSUS_UNIVERSE_ADVISORY_LOCK_KEY = 0x4348_554e; // "CHUN"

export const CONSENSUS_UNIVERSE_MIGRATION_VERSION = "2026-07-consensus-universe-v1";

export const PROPOSAL_SEEDS: ProposalSeedConfig[] = [
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
    adminOnly: false,
    status: "ongoing",
    themeKey: "nebula-violet",
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
  {
    id: "bip460",
    bipNumber: 460,
    shortName: "BIP460",
    title: "BIP-460",
    description: "Cross-Input Signature Aggregation",
    order: 3,
    enabled: true,
    adminOnly: false,
    status: "ongoing",
    themeKey: "nebula-yellow",
    emptyMessage: "Be the first to map this consensus galaxy.",
  },
];

const BY_ID = new Map(PROPOSAL_SEEDS.map((p) => [p.id, p]));
const BY_NUMBER = new Map(PROPOSAL_SEEDS.map((p) => [p.bipNumber, p]));

export function resolveProposalStatus(raw: unknown): ProposalStatus {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (key === "final" || key === "ongoing" || key === "draft") return key;
  return "ongoing";
}

export function isFinalProposalStatus(status: unknown): boolean {
  return resolveProposalStatus(status) === "final";
}

export function getProposalSeedById(id: unknown): ProposalSeedConfig | null {
  const key = String(id ?? "")
    .trim()
    .toLowerCase();
  return BY_ID.get(key) ?? null;
}

export function getProposalSeedByBipNumber(n: unknown): ProposalSeedConfig | null {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return BY_NUMBER.get(Math.trunc(num)) ?? null;
}

/** Accepts "bip110", "110", "BIP-110". Falls back when invalid. */
export function resolveProposalId(raw: unknown, fallback: ProposalId = DEFAULT_PROPOSAL_ID): ProposalId {
  return tryResolveProposalId(raw) ?? fallback;
}

/** Returns null when the identifier is unknown (does not fall back). */
export function tryResolveProposalId(raw: unknown): ProposalId | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^bip-?/, "");
  if (!s) return null;
  const asId = getProposalSeedById(`bip${s}`);
  if (asId) return asId.id;
  const asNum = getProposalSeedByBipNumber(s);
  if (asNum) return asNum.id;
  return null;
}

export function listEnabledProposalSeeds(): ProposalSeedConfig[] {
  return [...PROPOSAL_SEEDS].filter((p) => p.enabled).sort((a, b) => a.order - b.order);
}

/** @deprecated Prefer DB catalog; kept for unit tests and seed sync. */
export function listEnabledProposals(): ProposalSeedConfig[] {
  return listEnabledProposalSeeds();
}

/** @deprecated Prefer getProposalSeedById. */
export function getProposalById(id: unknown): ProposalSeedConfig | null {
  return getProposalSeedById(id);
}

/** @deprecated Prefer getProposalSeedByBipNumber. */
export function getProposalByBipNumber(n: unknown): ProposalSeedConfig | null {
  return getProposalSeedByBipNumber(n);
}

export type PublicProposalDto = {
  id: ProposalId;
  slug: string;
  bip_number: number;
  short_name: string;
  title: string;
  description: string;
  order: number;
  admin_only: boolean;
  status: ProposalStatus;
  theme_key: ProposalThemeKey;
  empty_message: string;
};

export function isValidThemeKey(raw: unknown): raw is ProposalThemeKey {
  return (
    raw === "nebula-red" ||
    raw === "nebula-cyan" ||
    raw === "nebula-violet" ||
    raw === "nebula-yellow"
  );
}
