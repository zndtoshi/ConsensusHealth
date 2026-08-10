export type CommunityUser = {
  handle: string;
  name?: string | null;
  avatar_url?: string | null;
  followers_count?: number | null;
  stance?: string | null;
  x_user_id?: string | null;
  bio?: string | null;
  accountCreatedAt?: string | null;
  account_created_at?: string | null;
  hasUserStanceChange?: boolean;
};

export type FetchCommunityUsersOptions = {
  proposal?: string;
  signal?: AbortSignal;
};

export async function fetchCommunityUsers(opts?: FetchCommunityUsersOptions): Promise<CommunityUser[]> {
  const { users } = await fetchCommunityUsersResult(opts);
  return users;
}

export async function fetchCommunityUsersResult(opts?: FetchCommunityUsersOptions): Promise<{
  ok: boolean;
  users: CommunityUser[];
}> {
  try {
    const base = ((import.meta as any).env?.VITE_API_BASE || "").replace(/\/$/, "");
    const params = new URLSearchParams();
    if (opts?.proposal) params.set("proposal", opts.proposal);
    const qs = params.toString();
    const res = await fetch(`${base}/api/community${qs ? `?${qs}` : ""}`, {
      credentials: "include",
      signal: opts?.signal,
    });
    if (!res.ok) return { ok: false, users: [] };
    const data = await res.json();
    const users = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [];
    return { ok: true, users };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return { ok: false, users: [] };
    console.warn("[ConsensusHealth] failed to load community users:", err);
    return { ok: false, users: [] };
  }
}
