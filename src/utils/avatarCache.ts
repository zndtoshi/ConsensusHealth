/**
 * Shared, session-scoped avatar image cache.
 *
 * Every avatar is keyed by its final resolved URL (canonicalized) so it is
 * downloaded/decoded exactly once and reused everywhere (canvas graph nodes and
 * DOM <img> elements alike). Concurrent requests for the same URL are
 * deduplicated because `getAvatar` returns the same `Image` object. Successful
 * loads and failures are recorded for the session so a known-broken URL is not
 * re-requested and callers can fall back to the placeholder without a network
 * round-trip.
 *
 * The DOM `Image` constructor is injected (defaulting to `new Image()`) so the
 * pure caching/deduplication logic is unit-testable without a browser.
 */

export type AvatarImageLike = {
  src: string;
  decoding?: string;
  loading?: string;
  referrerPolicy?: string;
  complete?: boolean;
  naturalWidth?: number;
  addEventListener?: (type: string, listener: () => void, opts?: { once?: boolean }) => void;
};

type ImageFactory = () => AvatarImageLike;

const defaultImageFactory: ImageFactory = () => new Image() as unknown as AvatarImageLike;

let imageFactory: ImageFactory = defaultImageFactory;

const avatarCache = new Map<string, AvatarImageLike>();
const loadedUrls = new Set<string>();
const failedUrls = new Set<string>();
let emptyAvatarImage: AvatarImageLike | null = null;

/**
 * Normalize avatar URL for deduping in-memory cache and stable browser cache keys.
 * - Trims whitespace
 * - Strips URL hash (not sent on image requests)
 * - Resolves relative URLs against the current document when available
 */
export function canonicalAvatarSrc(src: string): string {
  const s = String(src ?? "").trim();
  if (!s) return s;
  if (typeof window === "undefined" || !window.location?.href) {
    try {
      const u = new URL(s, "http://local.invalid/");
      u.hash = "";
      if (u.origin === "http://local.invalid") {
        return `${u.pathname}${u.search}`;
      }
      return u.href;
    } catch {
      return s;
    }
  }
  try {
    const u = new URL(s, window.location.href);
    u.hash = "";
    return u.href;
  } catch {
    return s;
  }
}

function getEmptyAvatarImage(): AvatarImageLike {
  if (!emptyAvatarImage) emptyAvatarImage = imageFactory();
  return emptyAvatarImage;
}

export function getAvatar(src: string): AvatarImageLike {
  const key = canonicalAvatarSrc(src);
  if (!key) {
    return getEmptyAvatarImage();
  }
  const existing = avatarCache.get(key);
  if (existing) return existing;

  const img = imageFactory();
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  // Record load/failure once so the session can avoid re-requesting broken URLs
  // and callers can resolve to a placeholder without another network hit.
  img.addEventListener?.(
    "load",
    () => {
      loadedUrls.add(key);
    },
    { once: true }
  );
  img.addEventListener?.(
    "error",
    () => {
      failedUrls.add(key);
    },
    { once: true }
  );
  img.src = key;
  avatarCache.set(key, img);
  return img;
}

/** Whether this avatar URL failed to load earlier in the current session. */
export function isAvatarUrlFailed(src: string): boolean {
  const key = canonicalAvatarSrc(src);
  return key ? failedUrls.has(key) : false;
}

/** Whether this avatar URL has already loaded successfully in this session. */
export function hasAvatarLoaded(src: string): boolean {
  const key = canonicalAvatarSrc(src);
  return key ? loadedUrls.has(key) : false;
}

/**
 * Preload a bounded list of avatar URLs once per session; dedupes URLs and in-flight keys.
 */
export function preloadAvatarUrls(urls: readonly string[], opts?: { eager?: boolean }): void {
  const seen = new Set<string>();
  for (const u of urls) {
    const k = canonicalAvatarSrc(String(u ?? "").trim());
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const img = getAvatar(k);
    if (opts?.eager && "loading" in img) {
      img.loading = "eager";
    }
  }
}

/** Test-only: inject a fake image factory. */
export function __setAvatarImageFactoryForTests(factory: ImageFactory | null): void {
  imageFactory = factory ?? defaultImageFactory;
}

/** Test-only: clear all cache/state. */
export function __resetAvatarCacheForTests(): void {
  avatarCache.clear();
  loadedUrls.clear();
  failedUrls.clear();
  emptyAvatarImage = null;
}
