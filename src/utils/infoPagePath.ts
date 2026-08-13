const INFO_PAGES = new Set(["privacy", "terms", "how-it-works"]);

/**
 * @param {string} pathname
 * @returns {"privacy" | "terms" | "how-it-works" | null}
 */
export function parseInfoPagePath(pathname: string | null | undefined): "privacy" | "terms" | "how-it-works" | null {
  const raw = String(pathname || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
  const seg = raw.startsWith("/") ? raw.slice(1) : raw;
  if (INFO_PAGES.has(seg)) return seg as "privacy" | "terms" | "how-it-works";
  return null;
}
