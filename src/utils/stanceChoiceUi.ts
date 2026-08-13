/**
 * Pure helpers for race-safe stance-card opening in E2E (and UI tests).
 * The auto-open overlay can appear after a visibility probe but before a
 * toolbar click; callers must not click through `.stanceChoiceOverlay`.
 */

export type StanceDialogOpenPlan = "wait-for-dialog" | "click-toolbar";

export function resolveStanceDialogOpenPlan(state: {
  overlayPresent: boolean;
  dialogPresent: boolean;
}): StanceDialogOpenPlan {
  if (state.overlayPresent || state.dialogPresent) return "wait-for-dialog";
  return "click-toolbar";
}

/** True when Playwright rejected a click because the stance overlay intercepted it. */
export function isStanceOverlayPointerInterceptError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error || "").toLowerCase();
  if (!message) return false;
  const mentionsOverlay =
    message.includes("stancechoiceoverlay") || message.includes("stance choice overlay");
  const intercept =
    message.includes("intercepts pointer events") ||
    message.includes("element is not visible") ||
    message.includes("subtree intercepts");
  return mentionsOverlay || (intercept && message.includes("stance"));
}
