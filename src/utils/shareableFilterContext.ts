import { FOLLOWER_FILTER_THRESHOLD } from "../config/followerFilters.js";

export type StanceKey = "against" | "neutral" | "approve";

export type ShareableFilterState = {
  plebsMode: boolean;
  influencersMode: boolean;
  joinDateFilterEnabled: boolean;
  joinDateMinYear: number | null;
  joinDateMaxYear: number | null;
};

export type StanceCountMap = Record<StanceKey, number>;

export type ShareableFilterBadgeModel = {
  visible: boolean;
  primaryLine: string;
  secondaryLine: string | null;
  totalLine: string;
  ariaSummary: string;
};

export const STANCE_COUNT_ORDER: readonly StanceKey[] = ["against", "neutral", "approve"];

export const STANCE_DISPLAY_LABELS: Record<StanceKey, string> = {
  against: "Against",
  neutral: "Neutral",
  approve: "Approve",
};

export function emptyStanceCounts(): StanceCountMap {
  return { against: 0, neutral: 0, approve: 0 };
}

export function countVisibleStances(
  accounts: ReadonlyArray<{ stance?: unknown }>,
  resolveStance: (account: { stance?: unknown }) => StanceKey | null
): { counts: StanceCountMap; total: number } {
  const counts = emptyStanceCounts();
  let total = 0;
  for (const account of accounts) {
    const stance = resolveStance(account);
    if (!stance) continue;
    counts[stance] += 1;
    total += 1;
  }
  return { counts, total };
}

/** Visibility filters that define the screenshot population (not equal-avatar). */
export function hasShareableVisibilityFilter(state: ShareableFilterState): boolean {
  if (state.plebsMode || state.influencersMode) return true;
  if (
    state.joinDateFilterEnabled &&
    state.joinDateMinYear != null &&
    state.joinDateMaxYear != null
  ) {
    return true;
  }
  return false;
}

function joinDateRangeText(minYear: number, maxYear: number): string {
  return `${minYear}–${maxYear}`;
}

/**
 * Compact badge copy for screenshots.
 * Plebs and Influencers are mutually exclusive in the UI; if both were ever on,
 * omit follower-category wording rather than contradicting.
 */
export function buildShareableFilterBadge(
  state: ShareableFilterState,
  visibleTotal: number
): ShareableFilterBadgeModel {
  const joinActive =
    state.joinDateFilterEnabled &&
    state.joinDateMinYear != null &&
    state.joinDateMaxYear != null;
  const joinText = joinActive
    ? joinDateRangeText(state.joinDateMinYear!, state.joinDateMaxYear!)
    : null;

  const bothFollower = state.plebsMode && state.influencersMode;
  const followerLabel = bothFollower
    ? null
    : state.plebsMode
      ? "Plebs"
      : state.influencersMode
        ? "Influencers"
        : null;
  const followerDetail = bothFollower
    ? null
    : state.plebsMode
      ? `Under ${Math.round(FOLLOWER_FILTER_THRESHOLD / 1000)}K followers`
      : state.influencersMode
        ? `Over ${Math.round(FOLLOWER_FILTER_THRESHOLD / 1000)}K followers`
        : null;

  if (!followerLabel && !joinText) {
    return {
      visible: false,
      primaryLine: "",
      secondaryLine: null,
      totalLine: "",
      ariaSummary: "",
    };
  }

  let primaryLine = "";
  let secondaryLine: string | null = null;

  if (followerLabel && joinText) {
    primaryLine = `${followerLabel} · X joined ${joinText}`;
    secondaryLine = null;
  } else if (followerLabel) {
    primaryLine = followerLabel;
    secondaryLine = followerDetail;
  } else {
    primaryLine = "X joined";
    secondaryLine = joinText;
  }

  const totalLine = `${visibleTotal} account${visibleTotal === 1 ? "" : "s"}`;

  const ariaParts: string[] = ["Filtered graph:"];
  if (followerLabel === "Plebs") {
    ariaParts.push(`Plebs under ${FOLLOWER_FILTER_THRESHOLD} followers.`);
  } else if (followerLabel === "Influencers") {
    ariaParts.push(`Influencers at or above ${FOLLOWER_FILTER_THRESHOLD} followers.`);
  }
  if (joinText) {
    ariaParts.push(
      `X joined ${state.joinDateMinYear} through ${state.joinDateMaxYear}.`
    );
  }
  ariaParts.push(`${visibleTotal} accounts shown.`);

  return {
    visible: true,
    primaryLine,
    secondaryLine,
    totalLine,
    ariaSummary: ariaParts.join(" "),
  };
}

export function appendStanceCountsToAria(
  base: string,
  counts: StanceCountMap
): string {
  if (!base) return "";
  return `${base} ${counts.against} against, ${counts.neutral} neutral, ${counts.approve} approve.`;
}

/** Resolve overlapping cluster label screen Y positions deterministically (Against, Neutral, Approve). */
export function resolveClusterLabelOverlaps(
  positions: Array<{ stance: StanceKey; x: number; y: number; visible: boolean }>,
  minGapPx: number
): Array<{ stance: StanceKey; x: number; y: number; visible: boolean }> {
  const next = positions.map((p) => ({ ...p }));
  const visible = next
    .map((p, index) => ({ ...p, index }))
    .filter((p) => p.visible)
    .sort((a, b) => a.y - b.y || STANCE_COUNT_ORDER.indexOf(a.stance) - STANCE_COUNT_ORDER.indexOf(b.stance));

  for (let i = 1; i < visible.length; i += 1) {
    const prev = visible[i - 1]!;
    const cur = visible[i]!;
    if (cur.y - prev.y < minGapPx) {
      cur.y = prev.y + minGapPx;
      next[cur.index]!.y = cur.y;
    }
  }
  return next;
}

export function worldToScreen(
  worldX: number,
  worldY: number,
  view: { scale: number; tx: number; ty: number }
): { x: number; y: number } {
  return {
    x: worldX * view.scale + view.tx,
    y: worldY * view.scale + view.ty,
  };
}
