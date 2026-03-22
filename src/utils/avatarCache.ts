const avatarCache = new Map<string, HTMLImageElement>();
const emptyAvatarImage = new Image();

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

export function getAvatar(src: string): HTMLImageElement {
  const key = canonicalAvatarSrc(src);
  if (!key) {
    return emptyAvatarImage;
  }
  if (!avatarCache.has(key)) {
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = key;
    avatarCache.set(key, img);
  }
  return avatarCache.get(key)!;
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
      (img as HTMLImageElement).loading = "eager";
    }
  }
}
