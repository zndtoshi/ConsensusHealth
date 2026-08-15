/**
 * Client helpers for the Name the PoW change fork easter-egg galaxy.
 */

export const NAME_THE_FORK_PATH = "/name-the-fork";
/** Exact user-facing title (route/API identifiers stay name-the-fork). */
export const NAME_THE_FORK_TITLE = "Name the PoW change fork";
export const NAME_THE_FORK_MAX_CHARS = 14;
export const NTF_PENDING_VOTE_KEY = "ch_ntf_pending_vote";

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

export function readPendingNameTheForkVote(): string | null {
  try {
    const raw = sessionStorage.getItem(NTF_PENDING_VOTE_KEY);
    const id = String(raw || "").trim();
    return id || null;
  } catch {
    return null;
  }
}

export function writePendingNameTheForkVote(candidateId: string): void {
  try {
    const id = String(candidateId || "").trim();
    if (!id) return;
    sessionStorage.setItem(NTF_PENDING_VOTE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function clearPendingNameTheForkVote(): void {
  try {
    sessionStorage.removeItem(NTF_PENDING_VOTE_KEY);
  } catch {
    /* ignore */
  }
}

export type PendingNameTheForkVoteDecision =
  | { type: "wait" }
  | { type: "clear" }
  | { type: "already_selected"; candidateId: string }
  | { type: "cast"; candidateId: string; changing: boolean };

/** Synchronous exclusive lock for candidate-vote POSTs (not remove/suggest/moderation). */
export type CandidateVoteWriteGate = {
  isHeld(): boolean;
  tryAcquire(): boolean;
  release(): void;
};

export function createCandidateVoteWriteGate(): CandidateVoteWriteGate {
  let held = false;
  return {
    isHeld: () => held,
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
  };
}

/**
 * Run at most one candidate-vote write at a time.
 * Concurrent callers get `skipped` without invoking `write` or busy/status callbacks.
 */
export async function runExclusiveCandidateVoteWrite<T>(options: {
  gate: CandidateVoteWriteGate;
  write: () => Promise<T>;
  onBusy?: (busy: boolean) => void;
  onSuccess?: (value: T) => void;
  onError?: (error: unknown) => void;
}): Promise<"ok" | "error" | "skipped"> {
  if (!options.gate.tryAcquire()) return "skipped";
  options.onBusy?.(true);
  try {
    const value = await options.write();
    options.onSuccess?.(value);
    return "ok";
  } catch (error) {
    options.onError?.(error);
    return "error";
  } finally {
    options.gate.release();
    options.onBusy?.(false);
  }
}

/**
 * Decide what to do with a stored anonymous one-click vote after auth/poll state settles.
 * Does not clear while login is in progress (`authBusy`) or a cast is already running.
 */
export function decidePendingNameTheForkVoteAction(input: {
  pendingCandidateId: string | null;
  authenticated: boolean;
  authBusy: boolean;
  pollReady: boolean;
  castInFlight: boolean;
  approvedCandidateIds: Iterable<string>;
  selectedCandidateId: string | null;
  /** Candidate id already consumed for a cast/clear in this authenticated session. */
  consumedCandidateId?: string | null;
}): PendingNameTheForkVoteDecision {
  const pendingId = String(input.pendingCandidateId || "").trim() || null;
  if (!pendingId) return { type: "wait" };
  if (input.authBusy || input.castInFlight) return { type: "wait" };
  if (!input.authenticated) return { type: "wait" };
  if (!input.pollReady) return { type: "wait" };
  if (input.consumedCandidateId && input.consumedCandidateId === pendingId) {
    return { type: "wait" };
  }

  const approved = new Set(
    [...(input.approvedCandidateIds || [])].map((id) => String(id || "").trim()).filter(Boolean)
  );
  if (!approved.has(pendingId)) return { type: "clear" };

  const selected = String(input.selectedCandidateId || "").trim() || null;
  if (selected === pendingId) {
    return { type: "already_selected", candidateId: pendingId };
  }
  return {
    type: "cast",
    candidateId: pendingId,
    changing: Boolean(selected),
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
      return "That name is already on the ballot or awaiting review.";
    case "custom_already_submitted":
      return "You’ve already suggested a custom name for this poll.";
    case "candidate_hidden":
    case "candidate_not_votable":
      return "That choice is no longer available.";
    case "unknown_candidate":
      return "That choice wasn’t found.";
    case "already_reviewed":
      return "That suggestion was already reviewed.";
    case "proposer_deleted":
      return "The proposer is no longer available; the suggestion was closed.";
    case "cannot_review_seed":
    case "cannot_hide_seed":
    case "cannot_hide_unapproved":
      return "That action isn’t allowed for this candidate.";
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
