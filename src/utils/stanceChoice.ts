/** Helpers for the floating stance choice card + single-chip toolbar. */

/** Strict optional stance: missing/empty stays null — never falls back to Neutral. */
export function strictNormalizedStance(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (v === "against") return "against";
  if (v === "neutral") return "neutral";
  if (v === "support" || v === "approve") return "approve";
  return null;
}

/**
 * True only when a persisted stance already exists and equals the next UI stance.
 * A missing stance is never "unchanged" — first-time Neutral must still write.
 */
export function isPersistedStanceUnchanged(currentRaw, nextUiStance) {
  const current = strictNormalizedStance(currentRaw);
  if (current == null) return false;
  const next = strictNormalizedStance(nextUiStance);
  if (next == null) return false;
  return current === next;
}

export function userHasChosenStance(me) {
  if (!me?.authenticated) return false;
  return strictNormalizedStance(me?.stance) != null;
}

export function shouldAutoOpenStanceChoice(me) {
  return Boolean(me?.authenticated) && !userHasChosenStance(me);
}

export function stanceChoiceMode(me) {
  return userHasChosenStance(me) ? "change" : "choose";
}

export function toolbarStanceMeta(uiStance) {
  if (uiStance === "against") {
    return { label: "Against", className: "stanceSeg--red", api: "against" };
  }
  if (uiStance === "approve") {
    return { label: "Approve", className: "stanceSeg--green", api: "support" };
  }
  if (uiStance === "neutral") {
    return { label: "Neutral", className: "stanceSeg--gray", api: "neutral" };
  }
  return null;
}
