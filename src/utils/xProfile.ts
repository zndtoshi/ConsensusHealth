export function normalizeXHandle(handle: unknown): string {
  return String(handle ?? "")
    .trim()
    .replace(/^@+/, "");
}

/** Build a safe x.com profile URL, or null if the handle is not usable. */
export function buildXProfileUrl(handle: unknown): string | null {
  const cleaned = normalizeXHandle(handle);
  if (!cleaned) return null;
  // X allows letters, numbers, and underscores. Reject anything else.
  if (!/^[A-Za-z0-9_]+$/.test(cleaned)) return null;
  return `https://x.com/${encodeURIComponent(cleaned)}`;
}

export function formatFollowerLabel(followersCount: number | null | undefined): string {
  if (followersCount == null || !Number.isFinite(followersCount) || followersCount < 0) {
    return "Followers unavailable";
  }
  const n = Math.trunc(followersCount);
  if (n === 1) return "1 follower";
  return `${new Intl.NumberFormat().format(n)} followers`;
}
