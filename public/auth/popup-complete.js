/**
 * OAuth popup completion helper (CSP script-src 'self' compatible).
 * Reads JSON from #ch-auth-payload and notifies the opener, then closes.
 */
(function () {
  try {
    var el = document.getElementById("ch-auth-payload");
    if (!el) return;
    var data = JSON.parse(el.textContent || "{}");
    var msg = data.message || { source: "consensushealth-oauth", status: "error" };
    var origin = typeof data.targetOrigin === "string" && data.targetOrigin ? data.targetOrigin : "*";
    var channelName =
      typeof data.channel === "string" && data.channel ? data.channel : "consensushealth-oauth";
    try {
      if (window.opener && !window.opener.closed) window.opener.postMessage(msg, origin);
    } catch {
      /* opener may be cross-origin or closed */
    }
    try {
      var bc = new BroadcastChannel(channelName);
      bc.postMessage(msg);
      bc.close();
    } catch {
      /* BroadcastChannel unsupported */
    }
    setTimeout(function () {
      try {
        window.close();
      } catch {
        /* window.close may be blocked */
      }
    }, 120);
  } catch {
    /* ignore malformed payload */
  }
})();
