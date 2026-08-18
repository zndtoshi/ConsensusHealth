/**
 * Locally hosted avatar storage with refresh-on-change.
 *
 * Downloads a user's X/Twitter profile image, stores the actual image bytes in
 * the local avatars directory, and records the local `avatar_path` plus the
 * remote `avatar_source_url` it was derived from. A stored avatar is refreshed
 * only when X reports a different profile image URL than the one that produced
 * the current local file.
 *
 * The core `createEnsureLocalAvatar` is dependency-injected so it can be unit
 * tested without a filesystem, database, or network. `createNodeAvatarDeps`
 * provides the real Node wiring (fs atomic writes, Postgres, fetch w/ timeout).
 *
 * Design rules (see requirements):
 * - Fetch when `avatar_path` is null/empty/missing OR the file is gone.
 * - Also fetch when the incoming remote URL differs from `avatar_source_url`
 *   (the URL the stored file came from). Same URL + present file => no request.
 * - `avatar_source_url` is unknown for files captured before this behavior
 *   existed, so those refresh once on the owner's next login and then settle.
 * - A refreshed image gets a NEW public path (`<x_user_id>-<rev>.<ext>`) because
 *   `/avatars` is served `immutable` with a one-year max-age; reusing the path
 *   would leave stale bytes in browser/CDN caches. `rev` is a content hash, so
 *   byte-identical images keep their path and cannot thrash.
 * - Store downloaded bytes, never the remote URL, as the local avatar. The
 *   public filename is derived from the stable x_user_id + content hash only,
 *   so the remote URL never leaks into it.
 * - Deterministic ownership prefix from the stable x_user_id (handles change).
 * - Validate content type + enforce a size limit; atomic temp-then-rename write.
 * - Update the DB only after the new file is safely written, then best-effort
 *   delete the superseded file. Cleanup failure is non-fatal.
 * - Deduplicate concurrent downloads for the same user.
 * - Never throw. A failed refresh returns the existing path so the current
 *   avatar stays usable; a failed first capture returns null (placeholder).
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

/**
 * Short content revision used to give refreshed avatars a new public path.
 * Derived from the image bytes only — never from the remote URL — so the same
 * picture keeps the same filename and a changed picture always gets a new one.
 */
export function avatarRevisionFromBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}

/**
 * Whether a public avatar path is a file this user's own capture produced,
 * i.e. named `<x_user_id>.<ext>` or `<x_user_id>-<rev>.<ext>`.
 *
 * Superseded-file cleanup is gated on this. Seed avatars are handle-named and
 * checked into the repo, and a user whose `avatar_path` still points at one
 * must not have it deleted out from under the static seed graph.
 */
export function isOwnedAvatarPath(publicPath: string, xUserId: string): boolean {
  const id = String(xUserId ?? "").trim();
  const clean = String(publicPath ?? "").trim();
  if (!id || !clean) return false;
  const m = clean.match(/^\/avatars\/([^/\\?#]+)$/);
  if (!m) return false;
  const base = m[1];
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem === id || stem.startsWith(`${id}-`);
}

/**
 * Public URL path for a stored avatar, keyed by the stable x_user_id.
 * Without `rev` this is the legacy immutable-name form, still produced for
 * files already on disk; with `rev` it is the cache-busting refresh form.
 */
export function avatarPublicPath(xUserId: string, ext: string, rev?: string | null): string {
  const suffix = String(rev ?? "").trim();
  return suffix ? `/avatars/${xUserId}-${suffix}.${ext}` : `/avatars/${xUserId}.${ext}`;
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
  /** DB truth for a user's stored avatar and the remote URL it was derived from. */
  getUser: (xUserId: string) => Promise<{
    avatar_path: string | null;
    avatar_url: string | null;
    avatar_source_url?: string | null;
  } | null>;
  /** Whether the file backing a public path (e.g. "/avatars/x.jpg") exists locally. */
  fileExists: (publicPath: string) => boolean;
  /** Atomically persist bytes as <filename> in the avatars dir (temp then rename). */
  writeAtomic: (filename: string, bytes: Uint8Array) => Promise<void>;
  /** Fetch remote image bytes (with timeout); returns null on network error/blocked host. */
  fetchImage: (url: string) => Promise<FetchedAvatar | null>;
  /** Persist the new avatar_path plus the remote URL it came from, in the DB. */
  setAvatarPath: (xUserId: string, avatarPath: string, sourceUrl: string) => Promise<void>;
  /** Best-effort removal of a superseded local file. Optional; must never throw. */
  deleteFile?: (publicPath: string) => Promise<void>;
  logger?: AvatarStorageLogger;
};

export type EnsureLocalAvatar = (user: EnsureLocalAvatarUser) => Promise<string | null>;

/**
 * Build the reusable `ensureLocalAvatar(user)` function.
 *
 * Returns the existing local path when a valid file is present and X still
 * reports the same profile image URL. When the URL changed (or nothing is
 * stored yet) it downloads, validates, writes, updates the DB, and returns the
 * new path. Never throws: a failed refresh falls back to the existing path and
 * a failed first capture returns null.
 */
export function createEnsureLocalAvatar(deps: AvatarStorageDeps): EnsureLocalAvatar {
  const inFlight = new Map<string, Promise<string | null>>();
  const log = deps.logger ?? {};

  async function run(user: EnsureLocalAvatarUser): Promise<string | null> {
    const xUserId = String(user?.x_user_id ?? "").trim();
    if (!xUserId) return null;
    let existingPath = "";
    try {
      const dbUser = await deps.getUser(xUserId);
      existingPath = String(dbUser?.avatar_path ?? user.avatar_path ?? "").trim();
      const hasLocalFile = Boolean(existingPath) && deps.fileExists(existingPath);

      const remoteUrl = String(user.avatar_url ?? dbUser?.avatar_url ?? "").trim();
      if (!remoteUrl) return hasLocalFile ? existingPath : null; // nothing to fetch

      if (hasLocalFile) {
        // Only the URL that produced the stored file decides staleness. An
        // unknown source (pre-refresh capture) refreshes once, then settles.
        const storedSourceUrl = String(dbUser?.avatar_source_url ?? "").trim();
        if (storedSourceUrl && storedSourceUrl === remoteUrl) return existingPath;
      }

      const fetched = await deps.fetchImage(remoteUrl);
      if (!fetched || !fetched.ok) {
        log.warn?.("[avatar-storage] fetch failed", { xUserId, status: fetched?.status ?? 0 });
        return hasLocalFile ? existingPath : null;
      }
      const ext = avatarExtForContentType(fetched.contentType);
      if (!ext) {
        log.warn?.("[avatar-storage] unsupported content-type", {
          xUserId,
          contentType: fetched.contentType,
        });
        return hasLocalFile ? existingPath : null;
      }
      const size = fetched.bytes.length;
      if (size === 0 || size > MAX_AVATAR_BYTES) {
        log.warn?.("[avatar-storage] invalid size", { xUserId, bytes: size });
        return hasLocalFile ? existingPath : null;
      }

      // Content-hashed name: refreshed bytes get a new immutable-cacheable URL.
      const rev = avatarRevisionFromBytes(fetched.bytes);
      const publicPath = avatarPublicPath(xUserId, ext, rev);
      const filename = `${xUserId}-${rev}.${ext}`;
      await deps.writeAtomic(filename, fetched.bytes);
      await deps.setAvatarPath(xUserId, publicPath, remoteUrl);
      log.info?.("[avatar-storage] stored avatar", {
        xUserId,
        publicPath,
        bytes: size,
        refreshed: hasLocalFile,
      });

      // Only after the DB points at the new file. Never fatal. Restricted to
      // files this user's own capture wrote, so seed avatars survive.
      if (
        hasLocalFile &&
        existingPath !== publicPath &&
        isOwnedAvatarPath(existingPath, xUserId)
      ) {
        try {
          await deps.deleteFile?.(existingPath);
        } catch (err) {
          log.warn?.("[avatar-storage] superseded cleanup failed", {
            xUserId,
            existingPath,
            err: String(err),
          });
        }
      }
      return publicPath;
    } catch (err) {
      log.warn?.("[avatar-storage] ensureLocalAvatar error", { xUserId, err: String(err) });
      // Preserve a usable existing avatar even when the refresh path threw.
      try {
        return existingPath && deps.fileExists(existingPath) ? existingPath : null;
      } catch {
        return null;
      }
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
        "SELECT avatar_path, avatar_url, avatar_source_url FROM community_users WHERE x_user_id = $1 LIMIT 1",
        [xUserId]
      );
      const r = rows[0] as
        | { avatar_path?: unknown; avatar_url?: unknown; avatar_source_url?: unknown }
        | undefined;
      if (!r) return null;
      return {
        avatar_path: r.avatar_path != null ? String(r.avatar_path) : null,
        avatar_url: r.avatar_url != null ? String(r.avatar_url) : null,
        avatar_source_url: r.avatar_source_url != null ? String(r.avatar_source_url) : null,
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
    async setAvatarPath(xUserId, avatarPath, sourceUrl) {
      await pool.query(
        `UPDATE community_users
         SET avatar_path = $2, avatar_source_url = NULLIF($3, ''), updated_at = now()
         WHERE x_user_id = $1`,
        [xUserId, avatarPath, sourceUrl ?? ""]
      );
    },
    async deleteFile(publicPath) {
      const fsPath = toLocalFsPath(publicPath);
      if (!fsPath) return;
      await fs.promises.rm(fsPath, { force: true }).catch(() => {});
    },
    logger: opts.logger,
  };
}
