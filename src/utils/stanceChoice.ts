/** Helpers for the floating stance choice card + single-chip toolbar. */

export function userHasChosenStance(me) {
  if (!me?.authenticated) return false;
  const raw = me?.stance;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "against" || v === "neutral" || v === "approve" || v === "support";
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
