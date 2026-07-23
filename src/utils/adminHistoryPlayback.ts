/**
 * Admin-only history playback: stage N avatars, hold, then launch with stagger
 * while refilling vacated slots from a chronological queue.
 */

export const HISTORY_STAGE_COUNT = 7;
export const HISTORY_HOLD_MS = 3000;
/** Delay between successive launches (0.2s). */
export const HISTORY_LAUNCH_STAGGER_MS = 200;
export const HISTORY_FLIGHT_MS = 1400;

export type HistoryStagingSlot = {
  cx: number;
  cy: number;
  side: number;
};

/** Horizontal row of staging positions (no background card). */
export function computeHistoryStagingSlots(
  count: number,
  viewW: number,
  viewH: number,
  headerH = 56
): HistoryStagingSlot[] {
  const n = Math.max(0, Math.min(HISTORY_STAGE_COUNT, Math.trunc(count)));
  if (n <= 0) return [];
  const side = Math.round(clamp(Math.min(viewW, viewH) * 0.07, 44, 58));
  const gap = 14;
  const totalW = n * side + (n - 1) * gap;
  const startX = viewW / 2 - totalW / 2 + side / 2;
  const cy = Math.max(headerH + 40, Math.min(viewH * 0.24, viewH * 0.35));
  const out: HistoryStagingSlot[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      cx: startX + i * (side + gap),
      cy,
      side,
    });
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Ease-in-out quadratic for flight interpolation. */
export function easeHistoryFlight(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

export type HistorySlotOccupant = {
  handle: string;
  /** Index into the full chronological sequence. */
  seqIndex: number;
};

/**
 * Fill empty staging slots from the sequence starting at `queueIndex`.
 * Returns the next queue index after filling.
 */
export function fillHistorySlots(opts: {
  slots: Array<HistorySlotOccupant | null>;
  sequence: Array<{ handle: string }>;
  queueIndex: number;
}): number {
  let qi = opts.queueIndex;
  for (let i = 0; i < opts.slots.length; i += 1) {
    if (opts.slots[i]) continue;
    if (qi >= opts.sequence.length) break;
    const item = opts.sequence[qi];
    if (!item?.handle) {
      qi += 1;
      i -= 1;
      continue;
    }
    opts.slots[i] = { handle: item.handle, seqIndex: qi };
    qi += 1;
  }
  return qi;
}

/**
 * Launch the next staged avatar in sequence order (lowest seqIndex still staged).
 * Vacated slot is immediately refilled from the queue.
 */
export function launchNextStagedAvatar(opts: {
  slots: Array<HistorySlotOccupant | null>;
  sequence: Array<{ handle: string }>;
  queueIndex: number;
  now: number;
  flightMs?: number;
}): {
  queueIndex: number;
  launched: null | {
    handle: string;
    slotIndex: number;
    startMs: number;
    endMs: number;
    fromCx: number;
    fromCy: number;
    fromSide: number;
  };
} {
  const flightMs = opts.flightMs ?? HISTORY_FLIGHT_MS;
  let bestSlot = -1;
  let bestSeq = Infinity;
  for (let i = 0; i < opts.slots.length; i += 1) {
    const occ = opts.slots[i];
    if (!occ) continue;
    if (occ.seqIndex < bestSeq) {
      bestSeq = occ.seqIndex;
      bestSlot = i;
    }
  }
  if (bestSlot < 0) {
    return { queueIndex: opts.queueIndex, launched: null };
  }
  const occ = opts.slots[bestSlot]!;
  opts.slots[bestSlot] = null;
  const queueIndex = fillHistorySlots({
    slots: opts.slots,
    sequence: opts.sequence,
    queueIndex: opts.queueIndex,
  });
  return {
    queueIndex,
    launched: {
      handle: occ.handle,
      slotIndex: bestSlot,
      startMs: opts.now,
      endMs: opts.now + flightMs,
      fromCx: 0,
      fromCy: 0,
      fromSide: 0,
    },
  };
}

export function historyPlaybackComplete(opts: {
  sequenceLength: number;
  landedCount: number;
  flyingCount: number;
  stagedCount: number;
  queueIndex: number;
}): boolean {
  if (opts.sequenceLength <= 0) return true;
  if (opts.landedCount < opts.sequenceLength) return false;
  if (opts.flyingCount > 0) return false;
  if (opts.stagedCount > 0) return false;
  return opts.queueIndex >= opts.sequenceLength;
}
