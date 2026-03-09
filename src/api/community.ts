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
};

export async function fetchCommunityUsers(): Promise<CommunityUser[]> {
  try {
    const base = ((import.meta as any).env?.VITE_API_BASE || "").replace(/\/$/, "");
    const res = await fetch(`${base}/api/community`, { credentials: "include" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("[ConsensusHealth] failed to load community users:", err);
    return [];
  }
}
