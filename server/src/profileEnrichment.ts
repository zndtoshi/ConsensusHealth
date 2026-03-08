type EnrichmentInput = {
  xUserId?: string | null;
  handle?: string | null;
};

export type ProfileEnrichment = {
  bio: string | null;
  accountCreatedAt: string | null;
};

type TwitterApiIoUser = Record<string, unknown>;

function normalizeBio(value: unknown): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizeDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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
  return direct;
}

function mapEnrichment(user: TwitterApiIoUser | null): ProfileEnrichment | null {
  if (!user) return null;
  const bio = normalizeBio(user.description ?? user.bio ?? null);
  const accountCreatedAt = normalizeDate(
    user.created_at ?? user.createdAt ?? user.account_created_at ?? user.accountCreatedAt ?? null
  );
  return { bio, accountCreatedAt };
}

async function requestTwitterApiIo(
  path: string,
  params: Record<string, string>,
  apiKey: string
): Promise<Record<string, unknown> | null> {
  const url = new URL(`https://api.twitterapi.io${path}`);
  for (const [k, v] of Object.entries(params)) {
    const value = String(v ?? "").trim();
    if (value) url.searchParams.set(k, value);
  }
  const res = await fetch(url.toString(), {
    headers: {
      "x-api-key": apiKey,
      accept: "application/json",
    },
  });
  if (!res.ok) return null;
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchProfileEnrichmentFromTwitterApiIo(
  input: EnrichmentInput,
  apiKey: string
): Promise<ProfileEnrichment | null> {
  const xUserId = String(input.xUserId ?? "").trim();
  const handle = String(input.handle ?? "").trim().replace(/^@+/, "");
  if (!xUserId && !handle) return null;

  if (xUserId && /^\d+$/.test(xUserId)) {
    const byId = await requestTwitterApiIo(
      "/twitter/user/batch_info_by_ids",
      { userIds: xUserId },
      apiKey
    );
    const parsed = mapEnrichment(extractUser(byId));
    if (parsed) return parsed;
  }

  if (handle) {
    const byHandle = await requestTwitterApiIo(
      "/twitter/user/info",
      { userName: handle },
      apiKey
    );
    const parsed = mapEnrichment(extractUser(byHandle));
    if (parsed) return parsed;
  }

  return null;
}
