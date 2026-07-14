import crypto from "node:crypto";

/**
 * Permanent, immutable avatar storage helpers.
 *
 * Avatars are stored once, keyed by the stable X user ID, and are never
 * overwritten or refreshed after the first successful insert. This module
 * contains the pure, dependency-injected logic (validation, provisioning,
 * HTTP-response shaping) so it can be unit-tested without a database, network,
 * or Express. The Postgres/`fetch` wiring lives in `index.ts`.
 */

export const ALLOWED_AVATAR_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type AllowedAvatarMimeType = (typeof ALLOWED_AVATAR_MIME_TYPES)[number];

/** Reject responses larger than 5 MB. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_AVATAR_MIME_TYPES);

/** Normalize a Content-Type header to one of the allowed image mime types, or null. */
export function normalizeAvatarMimeType(contentType: string | null | undefined): AllowedAvatarMimeType | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_MIME_SET.has(base) ? (base as AllowedAvatarMimeType) : null;
}

/**
 * X/Twitter profile image URLs carry a size suffix (`_normal`, `_bigger`,
 * `_mini`, or `_WxH`). Removing it yields the original, highest-quality image.
 */
export function highestQualityAvatarUrl(url: string | null | undefined): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  return raw.replace(/_(?:normal|bigger|mini|\d+x\d+)(?=\.[a-zA-Z0-9]+(?:$|\?))/, "");
}

/**
 * Square size (px) we normalize *future* avatar downloads to. The visualization
 * renders avatars at ~16–34px (a large header/donate avatar tops out well under
 * 200px), so storing full-resolution originals wastes Postgres and bandwidth.
 * X serves pre-sized square variants via a `_WxH` suffix, so we can request a
 * smaller, correctly-cropped image with no image-processing dependency.
 */
export const AVATAR_DOWNLOAD_SIZE = 400;

/**
 * Resolve the URL to download & store for a given source avatar URL, normalized
 * to a reasonable square size for the visualization. For X/twimg image hosts we
 * request the `_<size>x<size>` variant (X does the resize/crop on its CDN). Any
 * other host falls back to the highest-quality original. Never mutates already
 * stored blobs — this only affects what future downloads fetch.
 */
export function avatarDownloadUrl(
  url: string | null | undefined,
  size: number = AVATAR_DOWNLOAD_SIZE
): string | null {
  const base = highestQualityAvatarUrl(url);
  if (!base) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return base;
  }
  const host = parsed.hostname.toLowerCase();
  const isTwimg = host === "pbs.twimg.com" || host.endsWith(".twimg.com");
  if (!isTwimg) return base;
  // Insert `_SIZExSIZE` before the file extension of the path (e.g.
  // /profile_images/123/abc.jpg -> /profile_images/123/abc_400x400.jpg).
  const nextPath = parsed.pathname.replace(/(\.[a-zA-Z0-9]+)$/, `_${size}x${size}$1`);
  if (nextPath === parsed.pathname) return base;
  parsed.pathname = nextPath;
  return parsed.toString();
}

export type AvatarImageResponse = {
  ok: boolean;
  status: number;
  contentType: string | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type AvatarImageFetcher = (url: string) => Promise<AvatarImageResponse>;

export type AvatarFetchFailureReason =
  | "fetch_error"
  | "bad_status"
  | "invalid_content_type"
  | "too_large"
  | "empty";

export type AvatarFetchOutcome =
  | { ok: true; mimeType: AllowedAvatarMimeType; bytes: Buffer }
  | { ok: false; reason: AvatarFetchFailureReason };

/** Fetch an image URL and validate status, content type, and size. Never throws. */
export async function fetchValidatedAvatarImage(
  url: string,
  fetchImpl: AvatarImageFetcher,
  maxBytes: number = MAX_AVATAR_BYTES
): Promise<AvatarFetchOutcome> {
  let resp: AvatarImageResponse;
  try {
    resp = await fetchImpl(url);
  } catch {
    return { ok: false, reason: "fetch_error" };
  }
  if (!resp.ok) return { ok: false, reason: "bad_status" };
  const mimeType = normalizeAvatarMimeType(resp.contentType);
  if (!mimeType) return { ok: false, reason: "invalid_content_type" };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await resp.arrayBuffer());
  } catch {
    return { ok: false, reason: "fetch_error" };
  }
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large" };
  return { ok: true, mimeType, bytes };
}

export interface AvatarBlobStore {
  /** Whether a blob already exists for this stable X user ID. */
  has(xUserId: string): Promise<boolean>;
  /**
   * Insert with `ON CONFLICT DO NOTHING` semantics so concurrent callbacks can
   * never replace a stored image. Returns true only if THIS call inserted.
   */
  insertIfAbsent(xUserId: string, mimeType: string, bytes: Buffer): Promise<boolean>;
}

export type EnsureAvatarResult =
  | { status: "exists" }
  | { status: "stored" }
  | { status: "skipped_no_url" }
  | { status: "failed"; reason: AvatarFetchFailureReason };

export interface AvatarProvisioner {
  ensure(xUserId: string, imageUrl: string | null): Promise<EnsureAvatarResult>;
}

/**
 * Build a provisioner that, per stable X user ID:
 *  - does nothing if a blob already exists (never overwrites);
 *  - otherwise fetches, validates, and inserts the image;
 *  - deduplicates concurrent in-process downloads for the same user.
 * Failures leave the avatar missing so it is retried on a later login.
 */
export function createAvatarProvisioner(deps: {
  store: AvatarBlobStore;
  fetchImage: AvatarImageFetcher;
  maxBytes?: number;
  onError?: (xUserId: string, reason: AvatarFetchFailureReason) => void;
}): AvatarProvisioner {
  const inflight = new Map<string, Promise<EnsureAvatarResult>>();
  const maxBytes = deps.maxBytes ?? MAX_AVATAR_BYTES;

  async function run(xUserId: string, imageUrl: string | null): Promise<EnsureAvatarResult> {
    if (await deps.store.has(xUserId)) return { status: "exists" };
    const url = avatarDownloadUrl(imageUrl);
    if (!url) return { status: "skipped_no_url" };
    const outcome = await fetchValidatedAvatarImage(url, deps.fetchImage, maxBytes);
    if (!outcome.ok) {
      deps.onError?.(xUserId, outcome.reason);
      return { status: "failed", reason: outcome.reason };
    }
    const inserted = await deps.store.insertIfAbsent(xUserId, outcome.mimeType, outcome.bytes);
    return { status: inserted ? "stored" : "exists" };
  }

  function ensure(xUserId: string, imageUrl: string | null): Promise<EnsureAvatarResult> {
    const id = String(xUserId ?? "").trim();
    if (!id) return Promise.resolve<EnsureAvatarResult>({ status: "skipped_no_url" });
    const existing = inflight.get(id);
    if (existing) return existing;
    const p = run(id, imageUrl).finally(() => {
      if (inflight.get(id) === p) inflight.delete(id);
    });
    inflight.set(id, p);
    return p;
  }

  return { ensure };
}

export type AvatarBlob = { mimeType: string; bytes: Buffer };

export interface AvatarBlobReader {
  get(xUserId: string): Promise<AvatarBlob | null>;
}

export type AvatarHttpResponse =
  | { status: 404 }
  | { status: 304; headers: Record<string, string> }
  | { status: 200; headers: Record<string, string>; body: Buffer };

/** Strong ETag derived from the immutable image bytes. */
export function computeAvatarETag(bytes: Buffer): string {
  return `"${crypto.createHash("sha1").update(bytes).digest("hex")}"`;
}

/**
 * Resolve the HTTP response for `GET /avatars/:xUserId`: 404 when missing,
 * otherwise 200 (or 304 on a matching If-None-Match) with correct headers.
 */
export async function resolveAvatarHttpResponse(
  reader: AvatarBlobReader,
  xUserId: string,
  ifNoneMatch?: string | null
): Promise<AvatarHttpResponse> {
  const id = String(xUserId ?? "").trim();
  if (!id) return { status: 404 };
  const blob = await reader.get(id);
  if (!blob || !blob.bytes || blob.bytes.length === 0) return { status: 404 };
  const etag = computeAvatarETag(blob.bytes);
  const headers: Record<string, string> = {
    "Content-Type": blob.mimeType || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(blob.bytes.length),
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  };
  if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, headers };
  return { status: 200, headers, body: blob.bytes };
}
