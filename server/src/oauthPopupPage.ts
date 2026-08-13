/**
 * OAuth popup completion HTML (CSP script-src 'self' compatible).
 * Side-effect-free — safe to import from tests without booting the API.
 */

export const OAUTH_MESSAGE_SOURCE = "consensushealth-oauth";
export const OAUTH_CHANNEL_NAME = "consensushealth-oauth";

/**
 * Minimal self-closing page returned to the OAuth popup. Notifies the opener
 * via postMessage + BroadcastChannel, then closes. No secrets in the payload.
 *
 * Payload is non-executable application/json; behavior is /auth/popup-complete.js.
 */
export function renderAuthPopupPage(status: "success" | "error", frontendOrigin: string): string {
  const label = status === "success" ? "Signed in." : "Sign-in failed.";
  const payload = {
    message: { source: OAUTH_MESSAGE_SOURCE, status },
    targetOrigin: frontendOrigin || "*",
    channel: OAUTH_CHANNEL_NAME,
  };
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${label}</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0f1a;color:#e5e7eb;display:grid;place-items:center;height:100vh;margin:0">
<div>${label} You can close this window.</div>
<script type="application/json" id="ch-auth-payload">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script src="/auth/popup-complete.js"></script>
</body>
</html>`;
}
