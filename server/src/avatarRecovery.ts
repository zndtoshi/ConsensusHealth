/**
 * Avatar recovery via twitterapi.io (fresh profile image → permanent local file).
 *
 * Saves to /avatars/{handle}.jpg and updates community_users.avatar_path + avatar_url.
 */

import { normalizeHandle } from "./xUserId.js";

export type AvatarRecoveryCandidate = {
  x_user_id: string;
  handle: string | null;
  avatar_path: string | null;
  avatar_url: string | null;
};

export type AvatarRecoveryStats = {
  recovered: number;
  skipped: number;
  unavailable: number;
  failed: number;
};

export function emptyAvatarRecoveryStats(): AvatarRecoveryStats {
  return { recovered: 0, skipped: 0, unavailable: 0, failed: 0 };
}

export function formatAvatarRecoverySummary(stats: AvatarRecoveryStats): string {
  return [
    `Recovered: ${stats.recovered}`,
    `Skipped: ${stats.skipped}`,
    `Unavailable: ${stats.unavailable}`,
    `Failed: ${stats.failed}`,
  ].join("\n");
}

/** True when there is no usable local avatar file for this row. */
export function needsAvatarRecovery(
  row: Pick<AvatarRecoveryCandidate, "avatar_path">,
  fileExists: (publicPath: string) => boolean
): boolean {
  const path = String(row.avatar_path ?? "").trim();
  if (!path) return true;
  return !fileExists(path);
}

/**
 * Upgrade common Twitter CDN size suffixes to the largest available asset.
 * `_normal` / `_400x400` etc. → original (no size token).
 */
export function highestResTwitterAvatarUrl(url: string): string {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.pathname = u.pathname
      .replace(/_normal(?=\.\w+$)/i, "")
      .replace(/_bigger(?=\.\w+$)/i, "")
      .replace(/_mini(?=\.\w+$)/i, "")
      .replace(/_200x200(?=\.\w+$)/i, "")
      .replace(/_400x400(?=\.\w+$)/i, "")
      .replace(/_x96(?=\.\w+$)/i, "");
    return u.toString();
  } catch {
    return raw
      .replace(/_normal(\.\w+)(\?.*)?$/i, "$1$2")
      .replace(/_bigger(\.\w+)(\?.*)?$/i, "$1$2")
      .replace(/_mini(\.\w+)(\?.*)?$/i, "$1$2")
      .replace(/_200x200(\.\w+)(\?.*)?$/i, "$1$2")
      .replace(/_400x400(\.\w+)(\?.*)?$/i, "$1$2");
  }
}

export function isAllowedTwitterAvatarHost(hostname: string): boolean {
  const host = String(hostname ?? "").toLowerCase();
  return host === "pbs.twimg.com" || host.endsWith(".twimg.com");
}

/** Permanent public path required by recovery: /avatars/{handle}.jpg */
export function avatarRecoveryPublicPath(handle: string): string | null {
  const h = normalizeHandle(handle);
  if (!h) return null;
  if (!/^[a-z0-9_]{1,15}$/i.test(h)) return null;
  return `/avatars/${h}.jpg`;
}

export function extractProfileImageUrlFromUser(user: Record<string, unknown> | null): string | null {
  if (!user) return null;
  const candidates = [
    user.profilePicture,
    user.profile_image_url_https,
    user.profile_image_url,
    user.profileImageUrl,
    user.avatar,
    user.avatar_url,
    user.profile_image,
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if (!isAllowedTwitterAvatarHost(u.hostname)) continue;
      return highestResTwitterAvatarUrl(u.toString());
    } catch {
      continue;
    }
  }
  return null;
}

export type AvatarRecoveryOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "recovered"; avatarPath: string; avatarUrl: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "failed"; reason: string };

export type AvatarRecoveryProfile = {
  id: string | null;
  username: string | null;
  profileImageUrl: string | null;
  unavailable: boolean;
  unavailableReason: string | null;
};

export type AvatarRecoveryDeps = {
  fileExists: (publicPath: string) => boolean;
  fetchProfile: (input: {
    xUserId: string | null;
    handle: string | null;
  }) => Promise<AvatarRecoveryProfile | null>;
  fetchImage: (url: string) => Promise<{
    ok: boolean;
    status: number;
    contentType: string | null;
    bytes: Uint8Array;
  } | null>;
  writeAtomic: (filename: string, bytes: Uint8Array) => Promise<void>;
  updateAvatar: (args: {
    xUserId: string;
    avatarPath: string;
    avatarUrl: string;
  }) => Promise<void>;
  maxBytes?: number;
};

/**
 * Recover one account. Idempotent: skips when a valid local file already exists.
 */
export async function recoverOneAvatar(
  row: AvatarRecoveryCandidate,
  deps: AvatarRecoveryDeps
): Promise<AvatarRecoveryOutcome> {
  const xUserId = String(row.x_user_id ?? "").trim();
  if (!xUserId) return { kind: "failed", reason: "missing_x_user_id" };

  const handle = normalizeHandle(row.handle);
  if (!needsAvatarRecovery(row, deps.fileExists)) {
    return { kind: "skipped", reason: "valid_local_avatar" };
  }

  // Also skip if handle-named recovery file already exists (idempotent re-run).
  if (handle) {
    const handlePath = avatarRecoveryPublicPath(handle);
    if (handlePath && deps.fileExists(handlePath)) {
      return { kind: "skipped", reason: "handle_avatar_already_present" };
    }
  }

  const profile = await deps.fetchProfile({
    xUserId: /^\d+$/.test(xUserId) ? xUserId : null,
    handle,
  });

  if (!profile) {
    return { kind: "failed", reason: "profile_lookup_failed" };
  }
  if (profile.unavailable) {
    return {
      kind: "unavailable",
      reason: profile.unavailableReason || "unavailable",
    };
  }

  const resolvedHandle = normalizeHandle(profile.username) || handle;
  if (!resolvedHandle) {
    return { kind: "failed", reason: "missing_handle" };
  }

  const imageUrl = profile.profileImageUrl
    ? highestResTwitterAvatarUrl(profile.profileImageUrl)
    : null;
  if (!imageUrl) {
    return { kind: "failed", reason: "no_profile_image_url" };
  }

  try {
    const host = new URL(imageUrl).hostname;
    if (!isAllowedTwitterAvatarHost(host)) {
      return { kind: "failed", reason: "disallowed_avatar_host" };
    }
  } catch {
    return { kind: "failed", reason: "invalid_avatar_url" };
  }

  const fetched = await deps.fetchImage(imageUrl);
  if (!fetched || !fetched.ok) {
    return { kind: "failed", reason: `image_fetch_${fetched?.status ?? 0}` };
  }

  const maxBytes = deps.maxBytes ?? 5 * 1024 * 1024;
  if (!fetched.bytes.length || fetched.bytes.length > maxBytes) {
    return { kind: "failed", reason: "invalid_image_size" };
  }

  const ct = String(fetched.contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (ct && !ct.startsWith("image/")) {
    return { kind: "failed", reason: "unsupported_content_type" };
  }

  const publicPath = avatarRecoveryPublicPath(resolvedHandle);
  if (!publicPath) {
    return { kind: "failed", reason: "invalid_handle_for_path" };
  }

  // Requirement: always persist as /avatars/{handle}.jpg
  const filename = `${resolvedHandle}.jpg`;
  await deps.writeAtomic(filename, fetched.bytes);
  await deps.updateAvatar({
    xUserId,
    avatarPath: publicPath,
    avatarUrl: imageUrl,
  });

  return { kind: "recovered", avatarPath: publicPath, avatarUrl: imageUrl };
}
