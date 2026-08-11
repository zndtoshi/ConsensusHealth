/**
 * Validated visual themes for consensus galaxies.
 * theme_key from the API/DB must match a key here — never apply raw CSS from the database.
 */

export type ProposalThemeKey = "nebula-red" | "nebula-cyan" | "nebula-violet" | "nebula-yellow";

export type ProposalVisualTheme = {
  accent: string;
  accentSoft: string;
  nebulaFrom: string;
  nebulaTo: string;
  starTint: string;
  distantGlow: string;
};

export const PROPOSAL_THEMES: Record<ProposalThemeKey, ProposalVisualTheme> = {
  "nebula-red": {
    accent: "#f87171",
    accentSoft: "rgba(248, 113, 113, 0.35)",
    nebulaFrom: "rgba(127, 29, 29, 0.35)",
    nebulaTo: "rgba(15, 23, 42, 0.9)",
    starTint: "rgba(254, 202, 202, 0.55)",
    distantGlow: "rgba(239, 68, 68, 0.45)",
  },
  "nebula-cyan": {
    accent: "#22d3ee",
    accentSoft: "rgba(34, 211, 238, 0.35)",
    nebulaFrom: "rgba(8, 145, 178, 0.32)",
    nebulaTo: "rgba(15, 23, 42, 0.92)",
    starTint: "rgba(165, 243, 252, 0.55)",
    distantGlow: "rgba(34, 211, 238, 0.45)",
  },
  "nebula-violet": {
    accent: "#a78bfa",
    accentSoft: "rgba(167, 139, 250, 0.35)",
    nebulaFrom: "rgba(91, 33, 182, 0.32)",
    nebulaTo: "rgba(15, 23, 42, 0.92)",
    starTint: "rgba(221, 214, 254, 0.55)",
    distantGlow: "rgba(167, 139, 250, 0.45)",
  },
  "nebula-yellow": {
    accent: "#e8d48b",
    accentSoft: "rgba(232, 212, 139, 0.36)",
    nebulaFrom: "rgba(133, 98, 18, 0.3)",
    nebulaTo: "rgba(15, 23, 42, 0.92)",
    starTint: "rgba(254, 243, 199, 0.58)",
    distantGlow: "rgba(202, 168, 68, 0.45)",
  },
};

export const DEFAULT_THEME_KEY: ProposalThemeKey = "nebula-red";

export function resolveThemeKey(raw: unknown): ProposalThemeKey {
  const key = String(raw ?? "").trim();
  if (key in PROPOSAL_THEMES) return key as ProposalThemeKey;
  return DEFAULT_THEME_KEY;
}

export function getTheme(raw: unknown): ProposalVisualTheme {
  return PROPOSAL_THEMES[resolveThemeKey(raw)];
}
