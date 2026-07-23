/** Authorization and stance helpers for the admin halo avatar download. */

import { STANCE_COLORS, type StanceKey } from "./stanceColors.js";

export type HaloAvatarUserLike = {
  authenticated?: unknown;
  handle?: unknown;
  username?: unknown;
  screen_name?: unknown;
} | null | undefined;

function normalizeHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

/** True only for the authenticated X account with handle exactly "zndtoshi". */
export function isHaloAvatarAdmin(user: HaloAvatarUserLike): boolean {
  if (!user || user.authenticated !== true) return false;
  const handle = normalizeHandle(user.handle ?? user.username ?? user.screen_name);
  return handle === "zndtoshi";
}

export function normalizeHaloStance(value: unknown): StanceKey {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "against") return "against";
  if (v === "approve" || v === "support") return "approve";
  return "neutral";
}

export function haloColorForStance(stance: StanceKey): string {
  return STANCE_COLORS[stance];
}

export function haloAvatarFilename(stance: StanceKey): string {
  return `zndtoshi-consensus-halo-${normalizeHaloStance(stance)}.png`;
}

/**
 * Second-line guard before opening/generating. Throws if unauthorized so callers
 * cannot accidentally export for a stale UI session.
 */
export function assertHaloAvatarAdmin(user: HaloAvatarUserLike): void {
  if (!isHaloAvatarAdmin(user)) {
    throw new Error("Halo avatar download is only available to the authorized admin account.");
  }
}
