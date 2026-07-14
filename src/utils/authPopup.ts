// Contract shared with the server OAuth callback (server/src/index.ts).
// The popup page posts one of these messages (via postMessage + BroadcastChannel)
// so the opener can refresh only the session instead of reloading the whole app.
export const AUTH_MESSAGE_SOURCE = "consensushealth-oauth";
export const AUTH_CHANNEL_NAME = "consensushealth-oauth";

// sessionStorage key + freshness window for the popup-blocked redirect fallback.
export const LOGIN_RETURN_KEY = "consensushealth:loginReturn:v1";
export const LOGIN_RETURN_MAX_AGE_MS = 10 * 60 * 1000;

export type AuthResultMessage = {
  source: typeof AUTH_MESSAGE_SOURCE;
  status: "success" | "error";
};

/** True when the value is a well-formed auth result message from our popup. */
export function isAuthResultMessage(data: unknown): data is AuthResultMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.source === AUTH_MESSAGE_SOURCE && (d.status === "success" || d.status === "error");
}

/** True only for a successful auth result message. */
export function isAuthSuccessMessage(data: unknown): boolean {
  return isAuthResultMessage(data) && data.status === "success";
}

type PopupGeometry = {
  screenLeft?: number;
  screenTop?: number;
  screenX?: number;
  screenY?: number;
  outerWidth?: number;
  outerHeight?: number;
  innerWidth?: number;
  innerHeight?: number;
};

/**
 * Build the popup window features string, centered over the current window when
 * screen geometry is available.
 */
export function buildPopupFeatures(win?: PopupGeometry): string {
  const width = 600;
  const height = 720;
  let left = 0;
  let top = 0;
  try {
    const dualLeft = win?.screenLeft ?? win?.screenX ?? 0;
    const dualTop = win?.screenTop ?? win?.screenY ?? 0;
    const outerW = win?.outerWidth ?? win?.innerWidth ?? width;
    const outerH = win?.outerHeight ?? win?.innerHeight ?? height;
    left = Math.max(0, Math.round(dualLeft + (outerW - width) / 2));
    top = Math.max(0, Math.round(dualTop + (outerH - height) / 2));
  } catch {
    left = 0;
    top = 0;
  }
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}
