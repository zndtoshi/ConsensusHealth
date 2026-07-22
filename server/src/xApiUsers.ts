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
export async function getXAppBearerToken(): Promise<string> {
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
  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
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
  url: string
): Promise<{ data?: XUserPayload | XUserPayload[]; errors?: unknown }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`X API ${res.status}: ${txt.slice(0, 240)}`);
  }
  const text = await res.text();
  // Preserve long digit id fields if the API ever emits them as JSON numbers.
  const quoted = text.replace(
    /("(?:id|x_user_id|xUserId|userId|user_id)"\s*:\s*)(-?\d{15,})(\s*[,}\]])/g,
    '$1"$2"$3'
  );
  return JSON.parse(quoted) as { data?: XUserPayload | XUserPayload[]; errors?: unknown };
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
      const mapped = mapUser(row);
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
      const mapped = mapUser(row);
      if (mapped?.username) out.set(mapped.username, mapped);
    }
  }
  return out;
}
