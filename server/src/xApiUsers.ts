/**
 * Fetch public X user profile fields (created_at, description) via the official
 * X API v2 using app-only auth (client credentials from X_CLIENT_ID/SECRET or
 * an explicit X_BEARER_TOKEN).
 */

export type XApiUserProfile = {
  id: string;
  username: string;
  createdAt: string | null;
  bio: string | null;
};

/** Bounded timeout for explanation-verification X API calls. */
export const X_API_REQUEST_TIMEOUT_MS = 8_000;

export class XApiTimeoutError extends Error {
  status = 503;
  constructor(message = "X API request timed out") {
    super(message);
    this.name = "XApiTimeoutError";
  }
}

export function isXApiTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof XApiTimeoutError) return true;
  const name = String((err as { name?: unknown }).name || "");
  return name === "AbortError" || name === "TimeoutError" || name === "XApiTimeoutError";
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number = X_API_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const external = init?.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted && isXApiTimeoutError(err)) {
      throw new XApiTimeoutError();
    }
    if (controller.signal.aborted) {
      throw new XApiTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

function normalizeDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const token = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

/** App-only bearer: env token, or client-credentials grant from X_CLIENT_ID/SECRET. */
export async function getXAppBearerToken(opts?: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const explicit = (
    process.env.X_BEARER_TOKEN ||
    process.env.TWITTER_BEARER_TOKEN ||
    ""
  ).trim();
  if (explicit) return explicit;

  const clientId = (process.env.X_CLIENT_ID || process.env.TWITTER_CLIENT_ID || "").trim();
  const clientSecret = (process.env.X_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing X app credentials. Set X_BEARER_TOKEN or X_CLIENT_ID + X_CLIENT_SECRET."
    );
  }

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const res = await fetchWithTimeout(
    fetchImpl,
    "https://api.x.com/2/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(clientId, clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    opts?.timeoutMs ?? X_API_REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`X client_credentials failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  const token = String(json.access_token ?? "").trim();
  if (!token) throw new Error("X client_credentials response missing access_token");
  return token;
}

type XUserPayload = {
  id?: string;
  username?: string;
  created_at?: string;
  description?: string;
};

function mapUser(u: XUserPayload | null | undefined): XApiUserProfile | null {
  if (!u?.id) return null;
  const id = typeof u.id === "string" ? u.id.trim() : "";
  if (!/^\d+$/.test(id)) return null;
  return {
    id,
    username: String(u.username ?? "").trim().toLowerCase(),
    createdAt: normalizeDate(u.created_at),
    bio: String(u.description ?? "").trim() || null,
  };
}

async function xGet(
  bearer: string,
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = X_API_REQUEST_TIMEOUT_MS
): Promise<{ data?: unknown; errors?: unknown; status: number }> {
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      headers: {
        Authorization: `Bearer ${bearer}`,
        accept: "application/json",
      },
    },
    timeoutMs
  );
  const text = await res.text();
  // Preserve long digit id fields if the API ever emits them as JSON numbers.
  const quoted = text.replace(
    /("(?:id|author_id|x_user_id|xUserId|userId|user_id)"\s*:\s*)(-?\d{15,})(\s*[,}\]])/g,
    '$1"$2"$3'
  );
  let json: { data?: unknown; errors?: unknown } = {};
  try {
    json = quoted ? (JSON.parse(quoted) as { data?: unknown; errors?: unknown }) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const err = new Error(`X API ${res.status}: ${text.slice(0, 240)}`) as Error & {
      status?: number;
      body?: unknown;
    };
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { ...json, status: res.status };
}

export type XApiTweet = {
  id: string;
  authorId: string;
  text: string;
  createdAt: string | null;
};

type XTweetPayload = {
  id?: string;
  author_id?: string;
  text?: string;
  created_at?: string;
};

/**
 * Fetch a single public post by exact digit ID from the official X API v2.
 * Never fetch user-supplied URLs — only this fixed endpoint.
 */
export async function fetchXTweetById(
  bearer: string,
  tweetId: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<XApiTweet | null> {
  const id = String(tweetId ?? "").trim();
  if (!/^\d{1,30}$/.test(id)) return null;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const url =
    `https://api.x.com/2/tweets/${encodeURIComponent(id)}` +
    `?tweet.fields=author_id,text,created_at`;
  try {
    const json = await xGet(bearer, url, fetchImpl, opts?.timeoutMs ?? X_API_REQUEST_TIMEOUT_MS);
    const data = json.data as XTweetPayload | undefined;
    if (!data?.id || !data.author_id) return null;
    const outId = typeof data.id === "string" ? data.id.trim() : "";
    const authorId = typeof data.author_id === "string" ? data.author_id.trim() : "";
    if (!/^\d+$/.test(outId) || !/^\d+$/.test(authorId)) return null;
    return {
      id: outId,
      authorId,
      text: String(data.text ?? ""),
      createdAt: normalizeDate(data.created_at),
    };
  } catch (err) {
    if (isXApiTimeoutError(err)) throw err;
    const status = Number((err as { status?: number })?.status || 0);
    if (status === 404) return null;
    throw err;
  }
}

/** Lookup up to 100 users by numeric id. */
export async function fetchXUsersByIds(
  bearer: string,
  ids: string[]
): Promise<Map<string, XApiUserProfile>> {
  const out = new Map<string, XApiUserProfile>();
  const clean = [...new Set(ids.map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id)))];
  for (let i = 0; i < clean.length; i += 100) {
    const chunk = clean.slice(i, i + 100);
    const url =
      `https://api.x.com/2/users?ids=${encodeURIComponent(chunk.join(","))}` +
      `&user.fields=created_at,description`;
    const json = await xGet(bearer, url);
    const rows = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
    for (const row of rows) {
      const mapped = mapUser(row as XUserPayload);
      if (mapped) out.set(mapped.id, mapped);
    }
  }
  return out;
}

/** Lookup up to 100 users by username (no @). */
export async function fetchXUsersByUsernames(
  bearer: string,
  usernames: string[]
): Promise<Map<string, XApiUserProfile>> {
  const out = new Map<string, XApiUserProfile>();
  const clean = [
    ...new Set(
      usernames
        .map((h) => String(h ?? "").trim().toLowerCase().replace(/^@+/, ""))
        .filter(Boolean)
    ),
  ];
  for (let i = 0; i < clean.length; i += 100) {
    const chunk = clean.slice(i, i + 100);
    const url =
      `https://api.x.com/2/users/by?usernames=${encodeURIComponent(chunk.join(","))}` +
      `&user.fields=created_at,description`;
    const json = await xGet(bearer, url);
    const rows = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
    for (const row of rows) {
      const mapped = mapUser(row as XUserPayload);
      if (mapped?.username) out.set(mapped.username, mapped);
    }
  }
  return out;
}
