export type StanceKey = "against" | "neutral" | "approve";

/** Canonical stance colors reused across charts, legends, and history rows. */
export const STANCE_COLORS: Record<StanceKey, string> = {
  against: "#ef4444",
  neutral: "#9ca3af",
  approve: "#22c55e",
};

export const STANCE_LABELS: Record<StanceKey, string> = {
  against: "Against",
  neutral: "Neutral",
  approve: "Approve",
};

/**
 * Color for the final/new stance word only.
 * - approve -> green
 * - against -> red
 * - neutral / unset / unknown -> "inherit" (normal white text)
 */
export function finalStanceColor(to: StanceKey | null | undefined): string {
  if (to === "approve") return STANCE_COLORS.approve;
  if (to === "against") return STANCE_COLORS.against;
  return "inherit";
}
