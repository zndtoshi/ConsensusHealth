/**
 * Official unauthenticated X oEmbed verification for public posts.
 *
 * Ownership is verified by the current author handle in `author_url`, NOT by a
 * stable numeric X user ID (oEmbed does not expose author_id).
 *
 * Never follows redirects: the request contacts only the fixed publish.x.com
 * oEmbed endpoint (redirect: "manual"; any 3xx is rejected).
 */

import { fetchWithTimeout, isXApiTimeoutError, X_API_REQUEST_TIMEOUT_MS } from "./xApiUsers.js";
import { extractTweetTextFromOEmbedHtml } from "./oembedTweetText.js";
import { isConsensusHealthE2E } from "./e2eMockIdentity.js";

export const X_OEMBED_ENDPOINT = "https://publish.x.com/oembed";
export const X_OEMBED_MAX_BODY_BYTES = 256_000;

const ALLOWED_PROFILE_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

export type XOEmbedVerifyOk = {
  ok: true;
  tweetId: string;
  authorHandle: string;
  tweetText: string;
  responseUrl: string;
  /** Handle-level ownership only — not a stable author_id check. */
  verificationMethod: "x_oembed_author_handle";
};

export type XOEmbedVerifyErr = {
  ok: false;
  reason:
    | "oembed_unavailable"
    | "oembed_malformed"
    | "oembed_author_mismatch"
    | "oembed_text_missing"
    | "tweet_unavailable"
    | "timeout";
  statusHint: 404 | 403 | 502 | 503;
};

function normalizeHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function isValidUsername(value: string): boolean {
  return /^[a-z0-9_]{1,15}$/.test(value);
}

/** Strict HTTPS status URL: /{handle}/status/{digits} only — no query, fragment, port, or credentials. */
function parseStrictStatusUrl(raw: unknown): { handle: string; tweetId: string } | null {
  try {
    const url = new URL(String(raw ?? ""));
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (!ALLOWED_PROFILE_HOSTS.has(host)) return null;
    if (url.port || url.username || url.password) return null;
    if (url.search || url.hash) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3) return null;
    if (parts[1].toLowerCase() !== "status") return null;
    const handle = normalizeHandle(parts[0]);
    const tweetId = parts[2];
    if (!isValidUsername(handle)) return null;
    if (!/^\d{1,30}$/.test(tweetId)) return null;
    return { handle, tweetId };
  } catch {
    return null;
  }
}

function extractHandleFromAuthorUrl(raw: unknown): string | null {
  try {
    const url = new URL(String(raw ?? ""));
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (!ALLOWED_PROFILE_HOSTS.has(host)) return null;
    if (url.port || url.username || url.password) return null;
    if (url.search || url.hash) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    const handle = normalizeHandle(parts[0]);
    return isValidUsername(handle) ? handle : null;
  } catch {
    return null;
  }
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    if (text.length > maxBytes) return null;
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Verify a public post via fixed oEmbed endpoint only.
 * `canonicalPostUrl` must already be parser-canonicalized (https://x.com/{user}/status/{id}).
 */
export async function verifyPublicPostViaOEmbed(args: {
  canonicalPostUrl: string;
  expectedTweetId: string;
  expectedHandle: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<XOEmbedVerifyOk | XOEmbedVerifyErr> {
  const expectedHandle = normalizeHandle(args.expectedHandle);
  const expectedTweetId = String(args.expectedTweetId ?? "").trim();
  if (!expectedHandle || !/^\d{1,30}$/.test(expectedTweetId)) {
    return { ok: false, reason: "oembed_malformed", statusHint: 502 };
  }

  // CONSENSUSHEALTH_E2E + X_OAUTH_MOCK (never production): skip live publish.x.com.
  if (isConsensusHealthE2E(process.env)) {
    return {
      ok: true,
      tweetId: expectedTweetId,
      authorHandle: expectedHandle,
      tweetText: `E2E mock explanation from @${expectedHandle}`,
      responseUrl: args.canonicalPostUrl,
      verificationMethod: "x_oembed_author_handle",
    };
  }

  const endpoint = new URL(X_OEMBED_ENDPOINT);
  endpoint.searchParams.set("url", args.canonicalPostUrl);
  const requestUrl = endpoint.toString();
  if (!requestUrl.startsWith(`${X_OEMBED_ENDPOINT}?`)) {
    return { ok: false, reason: "oembed_malformed", statusHint: 502 };
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      requestUrl,
      {
        method: "GET",
        headers: { accept: "application/json" },
        // Never auto-follow: a 3xx Location could point anywhere. Contact only
        // the fixed publish.x.com/oembed URL; reject redirects as unavailable.
        redirect: "manual",
      },
      args.timeoutMs ?? X_API_REQUEST_TIMEOUT_MS
    );
  } catch (err) {
    if (isXApiTimeoutError(err)) {
      return { ok: false, reason: "timeout", statusHint: 503 };
    }
    return { ok: false, reason: "oembed_unavailable", statusHint: 503 };
  }

  if (res.status >= 300 && res.status < 400) {
    return { ok: false, reason: "oembed_unavailable", statusHint: 502 };
  }

  if (res.status === 404) {
    return { ok: false, reason: "tweet_unavailable", statusHint: 404 };
  }
  if (!res.ok) {
    return { ok: false, reason: "oembed_unavailable", statusHint: res.status >= 500 ? 503 : 502 };
  }

  const body = await readBodyLimited(res, X_OEMBED_MAX_BODY_BYTES);
  if (body == null) {
    return { ok: false, reason: "oembed_malformed", statusHint: 502 };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "oembed_malformed", statusHint: 502 };
  }

  const providerRaw = json.provider_name;
  if (providerRaw == null || String(providerRaw).trim() === "") {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }
  const provider = String(providerRaw).trim().toLowerCase();
  if (provider !== "twitter" && provider !== "x") {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }

  const typeRaw = json.type;
  if (typeRaw == null || String(typeRaw).trim() === "") {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }
  if (String(typeRaw).trim().toLowerCase() !== "rich") {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }

  const responseUrl = String(json.url ?? "").trim();
  const status = parseStrictStatusUrl(responseUrl);
  if (!status || status.tweetId !== expectedTweetId) {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }
  if (status.handle !== expectedHandle) {
    return { ok: false, reason: "oembed_author_mismatch", statusHint: 403 };
  }

  const authorHandle = extractHandleFromAuthorUrl(json.author_url);
  if (!authorHandle) {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }
  if (authorHandle !== expectedHandle || authorHandle !== status.handle) {
    return { ok: false, reason: "oembed_author_mismatch", statusHint: 403 };
  }

  const html = String(json.html ?? "");
  // Require the official post widget class — not an arbitrary blockquote or timeline.
  if (!/\btwitter-tweet\b/i.test(html) || !/<blockquote[\s>]/i.test(html)) {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }
  if (/\btwitter-timeline\b/i.test(html) && !/\btwitter-tweet\b/i.test(html)) {
    return { ok: false, reason: "oembed_malformed", statusHint: 404 };
  }

  const tweetText = extractTweetTextFromOEmbedHtml(html);
  if (!tweetText) {
    return { ok: false, reason: "oembed_text_missing", statusHint: 502 };
  }

  return {
    ok: true,
    tweetId: expectedTweetId,
    authorHandle,
    tweetText,
    responseUrl,
    verificationMethod: "x_oembed_author_handle",
  };
}
