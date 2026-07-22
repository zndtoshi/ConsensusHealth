/**
 * twitterapi.io profile enrichment helpers.
 *
 * Env key (Render): TWITTERAPI_API_KEY
 * Legacy local alias still accepted: TWITTERAPI_IO_KEY
 */

import {
  coerceXUserIdToDigitString,
  parseJsonPreservingSnowflakeIds,
} from "./xUserId.js";

export type EnrichmentInput = {
  xUserId?: string | null;
  handle?: string | null;
};

export type ProfileEnrichment = {
  id: string | null;
  username: string | null;
  bio: string | null;
  accountCreatedAt: string | null;
  unavailable: boolean;
  unavailableReason: string | null;
};

type TwitterApiIoUser = Record<string, unknown>;

export function resolveTwitterApiKey(
  env: NodeJS.ProcessEnv = process.env
): string {
  return String(env.TWITTERAPI_API_KEY || env.TWITTERAPI_IO_KEY || "").trim();
}

function normalizeBio(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

/** Parse ISO or Twitter-style dates like "Thu Dec 13 08:41:26 +0000 2007". */
export function normalizeTwitterApiDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normalizeHandle(value: unknown): string | null {
  const h = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  return h || null;
}

function extractUser(data: Record<string, unknown> | null): TwitterApiIoUser | null {
  if (!data || typeof data !== "object") return null;
  const direct = data as Record<string, unknown>;
  if (direct.data && typeof direct.data === "object" && !Array.isArray(direct.data)) {
    return direct.data as TwitterApiIoUser;
  }
  if (Array.isArray(direct.users) && direct.users.length > 0 && typeof direct.users[0] === "object") {
    return direct.users[0] as TwitterApiIoUser;
  }
  if (direct.user && typeof direct.user === "object" && !Array.isArray(direct.user)) {
    return direct.user as TwitterApiIoUser;
  }
  // Some single-user payloads are flat UserInfo objects.
  if (direct.id || direct.userName || direct.username || direct.createdAt || direct.created_at) {
    return direct;
  }
  return null;
}

export function mapEnrichment(user: TwitterApiIoUser | null): ProfileEnrichment | null {
  if (!user) return null;
  const unavailable = Boolean(user.unavailable);
  const unavailableReason = String(user.unavailableReason ?? user.message ?? "").trim() || null;
  const id = coerceXUserIdToDigitString(user.id);
  const username = normalizeHandle(user.userName ?? user.username ?? user.screen_name ?? null);
  const bio = normalizeBio(
    (user.profile_bio as { description?: unknown } | undefined)?.description ??
      user.description ??
      user.bio ??
      null
  );
  const accountCreatedAt = normalizeTwitterApiDate(
    user.createdAt ?? user.created_at ?? user.account_created_at ?? user.accountCreatedAt ?? null
  );
  return { id, username, bio, accountCreatedAt, unavailable, unavailableReason };
}

export type TwitterApiIoRequestResult = {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  rateLimited: boolean;
  retryAfterMs: number | null;
};

export async function requestTwitterApiIo(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<TwitterApiIoRequestResult> {
  const url = new URL(`https://api.twitterapi.io${path}`);
  for (const [k, v] of Object.entries(params)) {
    const value = String(v ?? "").trim();
    if (value) url.searchParams.set(k, value);
  }
  const res = await fetchImpl(url.toString(), {
    headers: {
      "X-API-Key": apiKey,
      accept: "application/json",
    },
  });
  const rateLimited = res.status === 429;
  let retryAfterMs: number | null = null;
  const retryAfter = res.headers?.get?.("retry-after");
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec) && sec > 0) retryAfterMs = Math.round(sec * 1000);
  }
  let json: Record<string, unknown> | null = null;
  try {
    const text = await res.text();
    json = parseJsonPreservingSnowflakeIds(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, rateLimited, retryAfterMs };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export type FetchEnrichmentOptions = {
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  onRateLimited?: (info: { attempt: number; waitMs: number }) => void;
};

export async function fetchProfileEnrichmentFromTwitterApiIo(
  input: EnrichmentInput,
  apiKey: string,
  opts: FetchEnrichmentOptions = {}
): Promise<ProfileEnrichment | null> {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("TWITTERAPI_API_KEY is required");

  const xUserId = String(input.xUserId ?? "").trim();
  const handle = normalizeHandle(input.handle);
  if (!xUserId && !handle) return null;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = Math.max(0, opts.maxRetries ?? 4);

  async function once(
    path: string,
    params: Record<string, string>
  ): Promise<ProfileEnrichment | null> {
    let attempt = 0;
    while (true) {
      const result = await requestTwitterApiIo(path, params, key, fetchImpl);
      if (result.rateLimited) {
        const waitMs = result.retryAfterMs ?? Math.min(30_000, 500 * 2 ** attempt);
        opts.onRateLimited?.({ attempt, waitMs });
        if (attempt >= maxRetries) return null;
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      if (!result.ok || !result.json) return null;
      return mapEnrichment(extractUser(result.json));
    }
  }

  if (xUserId && /^\d+$/.test(xUserId)) {
    const byId = await once("/twitter/user/batch_info_by_ids", { userIds: xUserId });
    if (byId) return byId;
  }

  if (handle) {
    return once("/twitter/user/info", { userName: handle });
  }

  return null;
}

/** Batch lookup by numeric ids (comma-separated). Returns map keyed by id. */
export async function fetchProfilesByIdsFromTwitterApiIo(
  ids: string[],
  apiKey: string,
  opts: FetchEnrichmentOptions = {}
): Promise<Map<string, ProfileEnrichment>> {
  const out = new Map<string, ProfileEnrichment>();
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("TWITTERAPI_API_KEY is required");
  const clean = [...new Set(ids.map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id)))];
  if (!clean.length) return out;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = Math.max(0, opts.maxRetries ?? 4);

  for (let i = 0; i < clean.length; i += 100) {
    const chunk = clean.slice(i, i + 100);
    let attempt = 0;
    while (true) {
      const result = await requestTwitterApiIo(
        "/twitter/user/batch_info_by_ids",
        { userIds: chunk.join(",") },
        key,
        fetchImpl
      );
      if (result.rateLimited) {
        const waitMs = result.retryAfterMs ?? Math.min(30_000, 500 * 2 ** attempt);
        opts.onRateLimited?.({ attempt, waitMs });
        if (attempt >= maxRetries) break;
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      if (result.ok && result.json) {
        const users = Array.isArray(result.json.users)
          ? (result.json.users as TwitterApiIoUser[])
          : [];
        // Also accept data array shapes.
        const dataArr = Array.isArray(result.json.data)
          ? (result.json.data as TwitterApiIoUser[])
          : [];
        for (const u of users.length ? users : dataArr) {
          const mapped = mapEnrichment(u);
          if (mapped?.id) out.set(mapped.id, mapped);
        }
      }
      break;
    }
  }
  return out;
}
