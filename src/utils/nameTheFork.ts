/**
 * Client helpers for the Name the Fork easter-egg galaxy.
 */

export const NAME_THE_FORK_PATH = "/name-the-fork";
export const NAME_THE_FORK_MAX_CHARS = 14;

export function isNameTheForkPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  return path === NAME_THE_FORK_PATH;
}

export function graphemeLength(text: string): number {
  const s = String(text ?? "");
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      return [...seg.segment(s)].length;
    } catch {
      /* fall through */
    }
  }
  return [...s].length;
}

export type NameNormalizeResult =
  | { ok: true; displayName: string; normalizedKey: string; length: number }
  | {
      ok: false;
      error:
        | "empty"
        | "too_long"
        | "invalid_chars"
        | "url"
        | "handle"
        | "markup"
        | "separator"
        | "control";
    };

export function normalizeCandidateName(raw: unknown): NameNormalizeResult {
  let s = String(raw ?? "");
  if (/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/.test(s)) {
    return { ok: false, error: "control" };
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return { ok: false, error: "empty" };
  if (/https?:\/\//i.test(s) || /www\./i.test(s)) return { ok: false, error: "url" };
  if (s.includes("@")) return { ok: false, error: "handle" };
  if (/[<>&`]/.test(s) || /<\/?[a-z]/i.test(s)) return { ok: false, error: "markup" };
  if (/^[\s\-_]|[\s\-_]$/.test(s) || /[\s\-_]{2,}/.test(s)) return { ok: false, error: "separator" };
  if (!/^[\p{L}\p{N}]+(?:[ \-_][\p{L}\p{N}]+)*$/u.test(s)) {
    return { ok: false, error: "invalid_chars" };
  }
  const length = graphemeLength(s);
  if (length > NAME_THE_FORK_MAX_CHARS) return { ok: false, error: "too_long" };
  return {
    ok: true,
    displayName: s,
    normalizedKey: s.normalize("NFKC").toLocaleLowerCase("en-US"),
    length,
  };
}

export function friendlyNameTheForkError(code: unknown): string {
  const key = String(code || "").trim();
  switch (key) {
    case "not_logged_in":
      return "Sign in with X to vote.";
    case "name_too_long":
      return `Names can be at most ${NAME_THE_FORK_MAX_CHARS} characters.`;
    case "invalid_name":
      return "That name isn’t allowed. Use letters, numbers, spaces, hyphens, or underscores.";
    case "reserved_name":
      return "That name is already a seeded choice.";
    case "duplicate_name":
      return "That name is already on the ballot.";
    case "custom_already_submitted":
      return "You’ve already suggested a custom name for this poll.";
    case "candidate_hidden":
      return "That choice is no longer available.";
    case "unknown_candidate":
      return "That choice wasn’t found.";
    case "rate_limited":
      return "Too many requests. Please wait and try again.";
    case "forbidden":
      return "You don’t have permission to do that.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** Emerald theme tokens for the hidden galaxy (not a BIP theme_key). */
export const NAME_THE_FORK_THEME = {
  accent: "#34d399",
  accentSoft: "rgba(52, 211, 153, 0.18)",
  nebulaFrom: "rgba(6, 78, 59, 0.22)",
  nebulaTo: "rgba(2, 6, 23, 0.75)",
  aura: "rgba(52, 211, 153, 0.55)",
};
