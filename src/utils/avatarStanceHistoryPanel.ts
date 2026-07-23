import { provenanceLabel, type AvatarStanceHistoryEvent } from "../api/avatarStanceHistory.js";

export type StanceKey = "against" | "neutral" | "approve";

export type HistoryPanelRow = {
  stance: StanceKey;
  label: string;
  dateLabel: string;
  provenance: "Curated" | "Self-reported";
};

export type HistoryPanelView =
  | { kind: "initial"; currentLabel: string }
  | { kind: "timeline"; rows: HistoryPanelRow[] };

const STANCE_LABELS: Record<StanceKey, string> = {
  against: "Against",
  neutral: "Neutral",
  approve: "Approve",
};

export function normalizeHistoryStance(value: unknown): StanceKey | null {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "against") return "against";
  if (v === "neutral") return "neutral";
  if (v === "approve" || v === "support") return "approve";
  return null;
}

export function formatHistoryMonthYear(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Build newest-first panel content from API history + current stance fallback. */
export function buildHistoryPanelView(
  events: AvatarStanceHistoryEvent[],
  currentStanceFallback: unknown
): HistoryPanelView {
  const timeline = [...events]
    .map((e) => {
      const stance = normalizeHistoryStance(e.new_stance);
      if (!stance) return null;
      return {
        stance,
        label: STANCE_LABELS[stance],
        dateLabel: formatHistoryMonthYear(e.changed_at),
        provenance: provenanceLabel(e.changed_by),
        previous: e.previous_stance,
        changed_by: e.changed_by,
      };
    })
    .filter(Boolean) as Array<HistoryPanelRow & { previous: string | null; changed_by: string | null }>;

  timeline.reverse(); // API is ASC; show newest first

  const onlyInitial =
    timeline.length === 0 ||
    (timeline.length === 1 &&
      timeline[0]!.previous == null &&
      String(timeline[0]!.changed_by || "").toLowerCase() !== "user");

  if (onlyInitial) {
    const fromEvent = timeline[0]?.stance ?? normalizeHistoryStance(currentStanceFallback);
    const currentLabel = fromEvent ? STANCE_LABELS[fromEvent] : "Unknown";
    return { kind: "initial", currentLabel };
  }

  return {
    kind: "timeline",
    rows: timeline.map(({ stance, label, dateLabel, provenance }) => ({
      stance,
      label,
      dateLabel,
      provenance,
    })),
  };
}

export function historyCacheKey(opts: { xUserId?: string | null; handle?: string | null }): string | null {
  const id = String(opts.xUserId || "").trim();
  if (id) return `id:${id}`;
  const handle = String(opts.handle || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  if (handle) return `h:${handle}`;
  return null;
}
