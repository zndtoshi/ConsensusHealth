/**
 * Strict allowlist parser for verified X stance-explanation post URLs.
 * Accepts only https://(www.)(x|twitter).com/{username}/status/{digitId}
 */

export const STANCE_EXPLANATION_URL_MAX_LENGTH = 512;

export type ParsedStanceExplanationUrl = {
  username: string;
  tweetId: string;
  /** Canonical https://x.com/{username}/status/{tweetId} */
  canonicalUrl: string;
};

export type StanceExplanationUrlError =
  | "empty"
  | "too_long"
  | "invalid_url"
  | "disallowed_scheme"
  | "disallowed_host"
  | "disallowed_port"
  | "credentials_present"
  | "disallowed_path"
  | "invalid_tweet_id"
  | "username_mismatch";

const ALLOWED_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

function isDigitOnlyId(value: string): boolean {
  return /^\d{1,30}$/.test(value);
}

function isValidUsername(value: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(value);
}

/**
 * Parse and canonicalize a user-supplied explanation URL.
 * `expectedHandle` is the authenticated session handle (no @); required match.
 */
export function parseStanceExplanationUrl(
  rawInput: unknown,
  expectedHandle: unknown
): { ok: true; value: ParsedStanceExplanationUrl } | { ok: false; error: StanceExplanationUrlError } {
  const raw = String(rawInput ?? "").trim();
  if (!raw) return { ok: false, error: "empty" };
  if (raw.length > STANCE_EXPLANATION_URL_MAX_LENGTH) return { ok: false, error: "too_long" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  if (url.protocol !== "https:") return { ok: false, error: "disallowed_scheme" };
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return { ok: false, error: "disallowed_host" };
  // Reject any explicit port in the user input (including default :443), not only url.port.
  if (/^https:\/\/[^/?#]+:\d+/i.test(raw) || url.port) {
    return { ok: false, error: "disallowed_port" };
  }
  if (url.username || url.password) return { ok: false, error: "credentials_present" };

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) return { ok: false, error: "disallowed_path" };
  const [usernameRaw, statusSeg, tweetId] = parts;
  if (String(statusSeg).toLowerCase() !== "status") return { ok: false, error: "disallowed_path" };
  if (!isValidUsername(usernameRaw)) return { ok: false, error: "disallowed_path" };
  if (!isDigitOnlyId(tweetId)) return { ok: false, error: "invalid_tweet_id" };

  const username = usernameRaw.toLowerCase();
  const expected = String(expectedHandle ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  if (!expected || username !== expected) return { ok: false, error: "username_mismatch" };

  return {
    ok: true,
    value: {
      username,
      tweetId,
      canonicalUrl: `https://x.com/${username}/status/${tweetId}`,
    },
  };
}
