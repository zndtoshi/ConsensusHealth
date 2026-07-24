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

export async function fetchCommunityUsers(opts?: {
  proposal?: string;
  signal?: AbortSignal;
}): Promise<CommunityUser[]> {
  try {
    const base = ((import.meta as any).env?.VITE_API_BASE || "").replace(/\/$/, "");
    const params = new URLSearchParams();
    if (opts?.proposal) params.set("proposal", opts.proposal);
    const qs = params.toString();
    const res = await fetch(`${base}/api/community${qs ? `?${qs}` : ""}`, {
      credentials: "include",
      signal: opts?.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.accounts)) return data.accounts;
    return [];
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return [];
    console.warn("[ConsensusHealth] failed to load community users:", err);
    return [];
  }
}
