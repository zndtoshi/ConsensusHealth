/** Basic client-side allowlist; server verification remains authoritative. */
export function looksLikeStanceExplanationUrl(raw: unknown): boolean {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 512) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host)) return false;
    if (url.port || url.username || url.password) return false;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3) return false;
    if (parts[1].toLowerCase() !== "status") return false;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(parts[0])) return false;
    if (!/^\d{1,30}$/.test(parts[2])) return false;
    return true;
  } catch {
    return false;
  }
}
