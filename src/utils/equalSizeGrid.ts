export const STANCE = {
  AGAINST: "against",
  NEUTRAL: "neutral",
  APPROVE: "approve",
} as const;

export type EqualSizeGridFillDirection = "column" | "row";

/** Default fill order for equal-size grids: highest followers left-to-right, then down. */
export const EQUAL_SIZE_GRID_FILL_DIRECTION: EqualSizeGridFillDirection = "row";

export type EqualSizeGridNode = {
  handle?: string;
  seedStance?: string;
  followers?: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  side?: number;
  half?: number;
};

export type EqualSizeGridRegion = {
  stanceCenterX: Record<string, number>;
  gapPx: number;
};

function normalizedStance(value: unknown): string {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === STANCE.AGAINST) return STANCE.AGAINST;
  if (v === STANCE.NEUTRAL) return STANCE.NEUTRAL;
  if (v === "support" || v === STANCE.APPROVE) return STANCE.APPROVE;
  return STANCE.NEUTRAL;
}

function getStanceForHandle(map: Record<string, string> | null | undefined, handle: unknown): string | undefined {
  const h = String(handle ?? "").trim();
  if (!h || !map) return undefined;
  return map[h] ?? map[h.toLowerCase()];
}

function getNodeStance(node: EqualSizeGridNode, labelsMap: Record<string, string>): string {
  return normalizedStance(getStanceForHandle(labelsMap, node.handle) || node.seedStance);
}

/**
 * Pack nodes into a screen-filling equal-size grid split into stance bands.
 * Within each band, nodes are sorted by followers (desc). Placement fills down
 * each column by default, or left-to-right across rows when fillDirection is "row".
 */
export function layoutEqualSizeGrid(
  nodes: EqualSizeGridNode[],
  labelsMap: Record<string, string>,
  w: number,
  h: number,
  fillDirection: EqualSizeGridFillDirection = EQUAL_SIZE_GRID_FILL_DIRECTION
): EqualSizeGridRegion | null {
  if (!nodes || nodes.length === 0 || w < 10 || h < 10) return null;
  const order = [STANCE.AGAINST, STANCE.NEUTRAL, STANCE.APPROVE];
  const groups: Record<string, EqualSizeGridNode[]> = {
    [STANCE.AGAINST]: [],
    [STANCE.NEUTRAL]: [],
    [STANCE.APPROVE]: [],
  };
  for (const n of nodes) {
    const st = getNodeStance(n, labelsMap);
    (groups[st] || groups[STANCE.NEUTRAL]).push(n);
  }
  for (const key of order) {
    groups[key].sort((a, b) => (b.followers || 0) - (a.followers || 0));
  }

  const counts = order.map((k) => groups[k].length);
  const total = counts.reduce((a, c) => a + c, 0);
  if (total === 0) return null;

  const margin = Math.max(8, Math.min(w, h) * 0.02);
  const usableW = Math.max(20, w - margin * 2);
  const usableH = Math.max(20, h - margin * 2);
  const activeBands = counts.filter((c) => c > 0).length;
  const bandGutter = Math.max(6, usableW * 0.015);
  const gutterTotal = bandGutter * Math.max(0, activeBands - 1);
  const gridW = Math.max(10, usableW - gutterTotal);

  let best: { R: number; totalCols: number; cell: number } | null = null;
  const maxRows = Math.min(total, 500);
  for (let R = 1; R <= maxRows; R++) {
    let totalCols = 0;
    for (const c of counts) if (c > 0) totalCols += Math.ceil(c / R);
    if (totalCols === 0) continue;
    const cell = Math.min(usableH / R, gridW / totalCols);
    if (!best || cell > best.cell) best = { R, totalCols, cell };
  }
  if (!best) return null;

  const { R, cell } = best;
  const colsPerBand = counts.map((c) => (c > 0 ? Math.ceil(c / R) : 0));
  const contentW = best.totalCols * cell + gutterTotal;
  const contentH = R * cell;
  const startX = (w - contentW) / 2;
  const startY = (h - contentH) / 2;
  const avatarSide = Math.max(6, cell * 0.9);

  const regionCenters: Record<string, number> = {};
  let xCursor = startX;
  for (let gi = 0; gi < order.length; gi++) {
    const key = order[gi];
    const list = groups[key];
    const cols = colsPerBand[gi];
    if (cols === 0) {
      regionCenters[key] = xCursor;
      continue;
    }
    const bandW = cols * cell;
    regionCenters[key] = xCursor + bandW / 2;
    for (let i = 0; i < list.length; i++) {
      let col: number;
      let row: number;
      if (fillDirection === "row") {
        row = Math.floor(i / cols);
        col = i % cols;
      } else {
        col = Math.floor(i / R);
        row = i % R;
      }
      const n = list[i]!;
      n.x = xCursor + col * cell + cell / 2;
      n.y = startY + row * cell + cell / 2;
      n.vx = 0;
      n.vy = 0;
      n.side = avatarSide;
      n.half = avatarSide / 2;
    }
    xCursor += bandW + bandGutter;
  }
  return { stanceCenterX: regionCenters, gapPx: bandGutter };
}
