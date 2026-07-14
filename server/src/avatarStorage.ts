/**
 * Permanent, one-time avatar storage.
 *
 * Downloads a user's X/Twitter profile image exactly once, stores the actual
 * image bytes in the local avatars directory, records the local `avatar_path`
 * in the database, and never fetches again once a valid local file exists.
 *
 * The core `createEnsureLocalAvatar` is dependency-injected so it can be unit
 * tested without a filesystem, database, or network. `createNodeAvatarDeps`
 * provides the real Node wiring (fs atomic writes, Postgres, fetch w/ timeout).
 *
 * Design rules (see requirements):
 * - A non-empty valid local `avatar_path` is immutable; never overwritten.
 * - Only fetch when `avatar_path` is null/empty/missing OR the file is gone.
 * - Store downloaded bytes, never the remote URL, as the permanent avatar.
 * - Deterministic filename from the stable x_user_id (handles can change).
 * - Validate content type + enforce a size limit; atomic temp-then-rename write.
 * - Deduplicate concurrent downloads for the same user.
 * - Never throw: failures return null so login/stance/page-load are unaffected.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
export const AVATAR_FETCH_TIMEOUT_MS = 5000;

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Map a Content-Type header to a file extension, or null if unsupported. */
export function avatarExtForContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const ct = String(contentType).split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_EXT[ct] ?? null;
}

/** Public URL path for a stored avatar, keyed by the stable x_user_id. */
export function avatarPublicPath(xUserId: string, ext: string): string {
  return `/avatars/${xUserId}.${ext}`;
}

/**
 * Resolve the directory where downloaded avatars are stored and served from.
 * Configurable via AVATAR_STORAGE_DIR (e.g. a Render persistent disk); defaults
 * to the statically served public avatar directory.
 */
export function resolveAvatarsDir(opts: {
  envDir?: string | null;
  isProd?: boolean;
  distPath: string;
  cwd: string;
}): string {
  const env = String(opts.envDir ?? "").trim();
  if (env) return path.resolve(env);
  return opts.isProd
    ? path.join(opts.distPath, "avatars")
    : path.join(opts.cwd, "public", "avatars");
}

export type FetchedAvatar = {
  ok: boolean;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
};

export type EnsureLocalAvatarUser = {
  x_user_id: string;
  avatar_path?: string | null;
  avatar_url?: string | null;
};

export type AvatarStorageLogger = {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
};

export type AvatarStorageDeps = {
  /** DB truth for a user's current avatar_path/avatar_url (source of immutability). */
  getUser: (
    xUserId: string
  ) => Promise<{ avatar_path: string | null; avatar_url: string | null } | null>;
  /** Whether the file backing a public path (e.g. "/avatars/x.jpg") exists locally. */
  fileExists: (publicPath: string) => boolean;
  /** Atomically persist bytes as <filename> in the avatars dir (temp then rename). */
  writeAtomic: (filename: string, bytes: Uint8Array) => Promise<void>;
  /** Fetch remote image bytes (with timeout); returns null on network error/blocked host. */
  fetchImage: (url: string) => Promise<FetchedAvatar | null>;
  /** Persist the new avatar_path in the DB. */
  setAvatarPath: (xUserId: string, avatarPath: string) => Promise<void>;
  logger?: AvatarStorageLogger;
};

export type EnsureLocalAvatar = (user: EnsureLocalAvatarUser) => Promise<string | null>;

/**
 * Build the reusable `ensureLocalAvatar(user)` function. Returns the existing
 * local path immediately when a valid file is present; otherwise fetches once,
 * stores it, updates the DB, and returns the new path. Returns null (never
 * throws) when there is nothing to fetch or the fetch/validation fails.
 */
export function createEnsureLocalAvatar(deps: AvatarStorageDeps): EnsureLocalAvatar {
  const inFlight = new Map<string, Promise<string | null>>();
  const log = deps.logger ?? {};

  async function run(user: EnsureLocalAvatarUser): Promise<string | null> {
    const xUserId = String(user?.x_user_id ?? "").trim();
    if (!xUserId) return null;
    try {
      const dbUser = await deps.getUser(xUserId);
      const existingPath = String(dbUser?.avatar_path ?? user.avatar_path ?? "").trim();
      // Immutable: a valid, existing local avatar is never refetched or replaced.
      if (existingPath && deps.fileExists(existingPath)) return existingPath;

      const remoteUrl = String(user.avatar_url ?? dbUser?.avatar_url ?? "").trim();
      if (!remoteUrl) return null; // nothing to fetch -> placeholder stays

      const fetched = await deps.fetchImage(remoteUrl);
      if (!fetched || !fetched.ok) {
        log.warn?.("[avatar-storage] fetch failed", { xUserId, status: fetched?.status ?? 0 });
        return null;
      }
      const ext = avatarExtForContentType(fetched.contentType);
      if (!ext) {
        log.warn?.("[avatar-storage] unsupported content-type", {
          xUserId,
          contentType: fetched.contentType,
        });
        return null;
      }
      const size = fetched.bytes.length;
      if (size === 0 || size > MAX_AVATAR_BYTES) {
        log.warn?.("[avatar-storage] invalid size", { xUserId, bytes: size });
        return null;
      }

      const filename = `${xUserId}.${ext}`;
      await deps.writeAtomic(filename, fetched.bytes);
      const publicPath = avatarPublicPath(xUserId, ext);
      await deps.setAvatarPath(xUserId, publicPath);
      log.info?.("[avatar-storage] stored avatar", { xUserId, publicPath, bytes: size });
      return publicPath;
    } catch (err) {
      log.warn?.("[avatar-storage] ensureLocalAvatar error", { xUserId, err: String(err) });
      return null;
    }
  }

  return function ensureLocalAvatar(user: EnsureLocalAvatarUser): Promise<string | null> {
    const xUserId = String(user?.x_user_id ?? "").trim();
    if (!xUserId) return Promise.resolve(null);
    // Prevent duplicate simultaneous downloads for the same user.
    const pending = inFlight.get(xUserId);
    if (pending) return pending;
    const p = run(user).finally(() => inFlight.delete(xUserId));
    inFlight.set(xUserId, p);
    return p;
  };
}

/** Real Node wiring for `AvatarStorageDeps` (filesystem + Postgres + fetch). */
export function createNodeAvatarDeps(opts: {
  pool: Pool;
  avatarsDir: string;
  isAllowedHost: (hostname: string) => boolean;
  timeoutMs?: number;
  logger?: AvatarStorageLogger;
}): AvatarStorageDeps {
  const { pool, avatarsDir } = opts;
  const timeoutMs = opts.timeoutMs ?? AVATAR_FETCH_TIMEOUT_MS;

  // Map a "/avatars/<name>" public path to its on-disk location, guarding
  // against path traversal by keeping only the basename.
  function toLocalFsPath(publicPath: string): string | null {
    const clean = String(publicPath ?? "").trim();
    const m = clean.match(/^\/avatars\/([^/\\?#]+)$/);
    if (!m) return null;
    const name = path.basename(m[1]);
    if (!name || name === "." || name === "..") return null;
    return path.join(avatarsDir, name);
  }

  return {
    async getUser(xUserId) {
      const { rows } = await pool.query(
        "SELECT avatar_path, avatar_url FROM community_users WHERE x_user_id = $1 LIMIT 1",
        [xUserId]
      );
      const r = rows[0] as { avatar_path?: unknown; avatar_url?: unknown } | undefined;
      if (!r) return null;
      return {
        avatar_path: r.avatar_path != null ? String(r.avatar_path) : null,
        avatar_url: r.avatar_url != null ? String(r.avatar_url) : null,
      };
    },
    fileExists(publicPath) {
      const fsPath = toLocalFsPath(publicPath);
      if (!fsPath) return false;
      try {
        return fs.existsSync(fsPath);
      } catch {
        return false;
      }
    },
    async writeAtomic(filename, bytes) {
      await fs.promises.mkdir(avatarsDir, { recursive: true });
      const safeName = path.basename(filename);
      const finalPath = path.join(avatarsDir, safeName);
      const tmpPath = path.join(
        avatarsDir,
        `.tmp-${safeName}-${crypto.randomBytes(6).toString("hex")}`
      );
      await fs.promises.writeFile(tmpPath, bytes);
      try {
        await fs.promises.rename(tmpPath, finalPath);
      } catch (err) {
        await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
    },
    async fetchImage(url) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return null;
      }
      if (!["http:", "https:"].includes(target.protocol)) return null;
      if (!opts.isAllowedHost(target.hostname)) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(target.toString(), {
          redirect: "follow",
          signal: controller.signal,
          headers: {
            "user-agent": "ConsensusHealthAvatarFetcher/1.0",
            accept: "image/*",
          },
        });
        const contentType = resp.headers.get("content-type");
        if (!resp.ok) {
          return { ok: false, status: resp.status, contentType, bytes: new Uint8Array() };
        }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        return { ok: true, status: resp.status, contentType, bytes };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async setAvatarPath(xUserId, avatarPath) {
      await pool.query(
        "UPDATE community_users SET avatar_path = $2, updated_at = now() WHERE x_user_id = $1",
        [xUserId, avatarPath]
      );
    },
    logger: opts.logger,
  };
}
