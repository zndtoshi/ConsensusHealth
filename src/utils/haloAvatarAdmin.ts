/** Authorization and stance helpers for the admin halo avatar download. */

import { STANCE_COLORS, type StanceKey } from "./stanceColors.js";

/**
 * Kill switch for the Account-menu “Download Halo Avatar” feature.
 * Set to true to re-enable for the authorized admin handle.
 */
export const HALO_AVATAR_DOWNLOAD_ENABLED = false;

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

/**
 * True only when the feature is enabled and the authenticated X account
 * handle is exactly "zndtoshi".
 */
export function isHaloAvatarAdmin(user: HaloAvatarUserLike): boolean {
  if (!HALO_AVATAR_DOWNLOAD_ENABLED) return false;
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

/**
 * Download basename for the exporting account.
 * `{handle}-consensus-halo-{stance}.png`
 */
export function haloAvatarFilename(stance: StanceKey, handle?: unknown): string {
  const h = normalizeHandle(handle) || "zndtoshi";
  return `${h}-consensus-halo-${normalizeHaloStance(stance)}.png`;
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
