/** User-facing copy for stance-explanation API machine codes. */

export const STANCE_EXPLANATION_ERROR_COPY: Record<string, string> = {
  verification_unavailable:
    "X verification is temporarily unavailable. Your explanation was not changed; please try again shortly.",
  verification_failed: "We could not verify this X post right now. Please try again shortly.",
  verification_rate_limited:
    "X verification is temporarily rate-limited. Please wait a moment and try again.",
  tweet_unavailable: "This X post could not be found or is not publicly accessible.",
  tweet_author_mismatch: "This post was not published by your connected X account.",
  invalid_tweet_url: "Enter a direct link to one of your X posts.",
  stance_required: "Choose a position before attaching an explanation.",
};

const MACHINE_CODES = new Set(Object.keys(STANCE_EXPLANATION_ERROR_COPY));

/** Prefer a safe server message; otherwise map known error codes; never show raw codes. */
export function friendlyStanceExplanationError(payload: {
  error?: unknown;
  message?: unknown;
  fallback?: string;
}): string {
  const message = String(payload.message ?? "").trim();
  const error = String(payload.error ?? "").trim();
  if (message && !MACHINE_CODES.has(message)) return message;
  if (error && STANCE_EXPLANATION_ERROR_COPY[error]) return STANCE_EXPLANATION_ERROR_COPY[error];
  if (message && STANCE_EXPLANATION_ERROR_COPY[message]) return STANCE_EXPLANATION_ERROR_COPY[message];
  return (
    payload.fallback ||
    "We could not verify this X post right now. Please try again shortly."
  );
}

export const PARTIAL_STANCE_EXPLANATION_STATUS =
  "Position saved, but the explanation link was not accepted.";
