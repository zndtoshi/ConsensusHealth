/**
 * Fixed distant-galaxy placement by proposal ID.
 * Slots never reshuffle when the active proposal changes — only the active
 * BIP’s button is hidden; the other galaxies stay put.
 */

export type DistantGalaxyPose = {
  x: number;
  y: number;
  scale: number;
  rotate: number;
};

/** Canonical corner slots for the four known BIPs (percent of viewport). */
export const CANONICAL_DISTANT_SLOTS: Record<string, DistantGalaxyPose> = {
  bip110: { x: 13, y: 17, scale: 0.92, rotate: -3.2 }, // top-left
  bip54: { x: 13, y: 78, scale: 0.86, rotate: 2.4 }, // bottom-left
  bip448: { x: 87, y: 17, scale: 0.9, rotate: 4.1 }, // top-right
  bip460: { x: 87, y: 78, scale: 0.84, rotate: -2.8 }, // bottom-right
};

/** Extra slots for future BIPs — never overwrite the four corners above. */
const FALLBACK_DISTANT_SLOTS: DistantGalaxyPose[] = [
  { x: 50, y: 14, scale: 0.8, rotate: 1.2 },
  { x: 50, y: 82, scale: 0.78, rotate: -1.5 },
  { x: 28, y: 48, scale: 0.76, rotate: 2.8 },
  { x: 72, y: 48, scale: 0.76, rotate: -2.2 },
  { x: 50, y: 48, scale: 0.72, rotate: 0.6 },
];

function hashSeed(text: string): number {
  return [...text].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
}

/**
 * Pose for a proposal. Index is ignored — positions are ID-stable only.
 * Unknown BIPs get a deterministic fallback that does not move the canonical four.
 */
export function distantLayout(proposalId: unknown, _index?: number): DistantGalaxyPose {
  const id = String(proposalId ?? "")
    .trim()
    .toLowerCase();
  const canonical = CANONICAL_DISTANT_SLOTS[id];
  if (canonical) return { ...canonical };

  const seed = hashSeed(id || "unknown");
  const slot = FALLBACK_DISTANT_SLOTS[seed % FALLBACK_DISTANT_SLOTS.length]!;
  // Tiny per-id jitter inside the fallback cell so two unknowns don’t stack.
  const xJitter = ((seed % 7) - 3) * 0.35;
  const yJitter = ((Math.floor(seed / 7) % 7) - 3) * 0.35;
  return {
    x: Math.min(90, Math.max(10, slot.x + xJitter)),
    y: Math.min(86, Math.max(12, slot.y + yJitter)),
    scale: slot.scale,
    rotate: slot.rotate + ((seed % 5) - 2) * 0.4,
  };
}
