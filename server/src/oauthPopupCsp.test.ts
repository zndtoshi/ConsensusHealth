import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createHelmetMiddleware } from "./security/httpSecurity.js";
import {
  OAUTH_CHANNEL_NAME,
  OAUTH_MESSAGE_SOURCE,
  renderAuthPopupPage,
} from "./oauthPopupPage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const popupScriptPath = path.join(root, "public", "auth", "popup-complete.js");

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

function buildPopupApp() {
  const app = express();
  app.disable("x-powered-by");
  const helmetMw = createHelmetMiddleware({ isProd: true });
  // Helmet on auth routes (production popup HTML + script). Opener is a test harness.
  app.use("/auth", helmetMw);
  app.get("/auth/popup-complete.js", (_req, res) => {
    res.type("application/javascript");
    res.sendFile(popupScriptPath);
  });
  app.get("/auth/popup-test", (req, res) => {
    const status = String(req.query.status || "success") === "error" ? "error" : "success";
    const host = req.get("host") || "127.0.0.1";
    const origin = String(req.query.origin || `http://${host}`);
    res.status(200).type("html").send(renderAuthPopupPage(status, origin));
  });
  app.get("/opener", (req, res) => {
    const status = String(req.query.status || "success") === "error" ? "error" : "success";
    const host = req.get("host") || "127.0.0.1";
    const base = `http://${host}`;
    const popupUrl = `${base}/auth/popup-test?status=${encodeURIComponent(status)}&origin=${encodeURIComponent(base)}`;
    res.status(200).type("html").send(`<!doctype html>
<html><body>
<button id="open" type="button">Open</button>
<script>
window.__msgs = [];
window.addEventListener("message", function (ev) {
  window.__msgs.push({ data: ev.data, origin: ev.origin, via: "postMessage" });
});
try {
  var bc = new BroadcastChannel(${JSON.stringify(OAUTH_CHANNEL_NAME)});
  bc.onmessage = function (ev) {
    window.__msgs.push({ data: ev.data, via: "broadcast" });
  };
} catch (e) {}
document.getElementById("open").onclick = function () {
  window.open(${JSON.stringify(popupUrl)}, "oauth_popup");
};
</script>
</body></html>`);
  });
  return app;
}

test("OAuth popup HTML + CSP allow external script without unsafe-inline", async () => {
  assert.ok(fs.existsSync(popupScriptPath), "public/auth/popup-complete.js must exist");

  await withServer(buildPopupApp(), async (base) => {
    const pageRes = await fetch(`${base}/auth/popup-test?origin=${encodeURIComponent(base)}`);
    assert.equal(pageRes.status, 200);
    const csp = pageRes.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src[^;]*'self'/i);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/i);

    const html = await pageRes.text();
    assert.match(html, /id="ch-auth-payload"/);
    assert.match(html, /type="application\/json"/);
    assert.match(html, /src="\/auth\/popup-complete\.js"/);
    assert.match(html, new RegExp(OAUTH_MESSAGE_SOURCE));
    assert.match(html, new RegExp(OAUTH_CHANNEL_NAME));
    assert.doesNotMatch(
      html,
      /<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/json["'])[^>]*>[\s\S]*?<\/script>/i
    );

    const scriptRes = await fetch(`${base}/auth/popup-complete.js`);
    assert.equal(scriptRes.status, 200);
    const js = await scriptRes.text();
    assert.match(js, /postMessage/);
    assert.match(js, /BroadcastChannel/);
    assert.match(js, /targetOrigin/);
  });
});

test("production popup script executes under Helmet CSP (BroadcastChannel + configured origin)", async () => {
  assert.ok(fs.existsSync(popupScriptPath));

  await withServer(buildPopupApp(), async (base) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/opener?status=success`, { waitUntil: "domcontentloaded" });

      await Promise.all([page.waitForEvent("popup"), page.click("#open")]);
      // Popup may self-close quickly; assert via BroadcastChannel on the opener.
      await page.waitForFunction(
        () =>
          (window as unknown as { __msgs: Array<{ data?: { status?: string } }> }).__msgs.some(
            (m) => m.data?.status === "success"
          ),
        null,
        { timeout: 10_000 }
      );
      const msgs = (await page.evaluate(
        () =>
          (window as unknown as { __msgs: Array<{ data: { source?: string; status?: string }; via?: string }> })
            .__msgs
      )) as Array<{ data: { source?: string; status?: string }; via?: string }>;
      assert.ok(msgs.length >= 1, "expected notification from production popup script");
      const success = msgs.find((m) => m.data.status === "success");
      assert.ok(success);
      assert.equal(success!.data.source, OAUTH_MESSAGE_SOURCE);
      assert.ok(
        msgs.some((m) => m.via === "broadcast" || m.via === "postMessage"),
        "expected broadcast or postMessage path"
      );

      // Confirm production HTML encodes the configured target origin (fetch, not closed popup).
      const rendered = await fetch(
        `${base}/auth/popup-test?status=success&origin=${encodeURIComponent(base)}`
      ).then((r) => r.text());
      assert.match(rendered, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      await page.goto(`${base}/opener?status=error`, { waitUntil: "domcontentloaded" });
      await Promise.all([page.waitForEvent("popup"), page.click("#open")]);
      await page.waitForFunction(
        () =>
          (window as unknown as { __msgs: Array<{ data?: { status?: string } }> }).__msgs.some(
            (m) => m.data?.status === "error"
          ),
        null,
        { timeout: 10_000 }
      );
    } finally {
      await browser.close();
    }
  });
});
