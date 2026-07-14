/**
 * Recover a user's current avatar URL from their public x.com profile page,
 * without the X API. The page's Open Graph `og:image` meta tag exposes the
 * current profile image (a `pbs.twimg.com/profile_images/...` URL) as stable
 * metadata. Pure extraction/validation lives here so it is unit-testable; the
 * live HTTP fetch is injected by the caller (see scripts/recoverAvatars.ts).
 */

export function isTrustedXImageHost(hostname: string): boolean {
  const host = String(hostname ?? "").toLowerCase();
  return host === "pbs.twimg.com" || host.endsWith(".twimg.com");
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&#38;/g, "&");
}

// og:image with either attribute order (content before or after property).
const OG_IMAGE_PATTERNS = [
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
];
// Fallback: the first embedded profile-image URL anywhere in the HTML.
const PBS_PROFILE_IMAGE_PATTERN = /https:\/\/pbs\.twimg\.com\/profile_images\/[^\s"'<>\\)]+/i;

/**
 * Extract the avatar URL from profile-page HTML. Accepts only trusted X image
 * hosts and only the avatar path (`/profile_images/`), never the banner
 * (`/profile_banners/`, which X exposes as `twitter:image`).
 */
export function extractAvatarUrlFromProfileHtml(html: string): string | null {
  const text = String(html ?? "");
  const candidates: string[] = [];
  for (const pattern of OG_IMAGE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) candidates.push(match[1]);
  }
  const pbs = text.match(PBS_PROFILE_IMAGE_PATTERN);
  if (pbs?.[0]) candidates.push(pbs[0]);

  for (const raw of candidates) {
    const cleaned = decodeBasicEntities(raw).trim();
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") continue;
    if (!isTrustedXImageHost(parsed.hostname)) continue;
    if (!parsed.pathname.includes("/profile_images/")) continue;
    return cleaned;
  }
  return null;
}

/** Detect a login wall / bot challenge / empty shell instead of a real profile. */
export function isLikelyBlockedHtml(html: string): boolean {
  const text = String(html ?? "");
  if (text.length < 500) return true;
  if (/JavaScript is not available/i.test(text)) return true;
  return false;
}

export type XProfileFetchReason =
  | "blocked"
  | "not_found"
  | "rate_limited"
  | "forbidden"
  | "no_avatar"
  | "bad_status"
  | "fetch_error"
  | "timeout"
  | "invalid_handle";

export type XProfileFetchResult = { ok: true; url: string } | { ok: false; reason: XProfileFetchReason };

export type ProfilePageResponse = { status: number; ok: boolean; text: () => Promise<string> };
export type ProfilePageFetcher = (handle: string) => Promise<ProfilePageResponse>;

export function normalizeScrapeHandle(handle: string): string {
  return String(handle ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

/** X handles are 1–15 chars of [A-Za-z0-9_]. */
export function isValidXHandle(handle: string): boolean {
  return /^[a-z0-9_]{1,15}$/.test(normalizeScrapeHandle(handle));
}

export async function fetchXProfileAvatarUrl(
  handle: string,
  fetchPage: ProfilePageFetcher
): Promise<XProfileFetchResult> {
  const normalized = normalizeScrapeHandle(handle);
  if (!isValidXHandle(normalized)) return { ok: false, reason: "invalid_handle" };

  let resp: ProfilePageResponse;
  try {
    resp = await fetchPage(normalized);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    return { ok: false, reason: name === "AbortError" ? "timeout" : "fetch_error" };
  }

  if (resp.status === 429) return { ok: false, reason: "rate_limited" };
  if (resp.status === 403) return { ok: false, reason: "forbidden" };
  if (resp.status === 404) return { ok: false, reason: "not_found" };
  if (!resp.ok) return { ok: false, reason: "bad_status" };

  let html: string;
  try {
    html = await resp.text();
  } catch {
    return { ok: false, reason: "fetch_error" };
  }

  if (isLikelyBlockedHtml(html)) return { ok: false, reason: "blocked" };
  const url = extractAvatarUrlFromProfileHtml(html);
  if (!url) return { ok: false, reason: "no_avatar" };
  return { ok: true, url };
}
