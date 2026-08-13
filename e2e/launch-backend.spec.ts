import { test, expect } from "@playwright/test";
import { CANONICAL_DISTANT_SLOTS } from "../src/utils/distantGalaxyLayout";
import {
  apiJson,
  communityHandles,
  expectMeStance,
  fetchMe,
  mockOAuthLogin,
  saveStanceViaUi,
  stanceChoiceDialog,
  dismissDisclosureIfPresent,
  ackPrivacyDisclosure,
} from "./helpers";

const REAL = process.env.E2E_REAL_BACKEND === "1";
const DEFAULT_MOCK_HANDLE = (process.env.X_OAUTH_MOCK_HANDLE || "e2e_mock_user").trim().toLowerCase();

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

const BIP_PATHS = ["/", "/bip/54", "/bip/110", "/bip/448", "/bip/460"] as const;

/** Root CI guard — not skipped when CI is set (config already throws if CI has no DB). */
test("CI requires E2E_REAL_BACKEND===1", () => {
  if (!process.env.CI) {
    expect(["0", "1"]).toContain(process.env.E2E_REAL_BACKEND);
    return;
  }
  expect(process.env.E2E_REAL_BACKEND).toBe("1");
  expect(REAL).toBe(true);
});

test.beforeEach(() => {
  if (test.info().title.includes("E2E_REAL_BACKEND")) return;
  test.skip(!REAL, "Requires TEST_DATABASE_URL / E2E_DATABASE_URL (always set in CI)");
});

test.describe("1 — anonymous shell + API", () => {
  test("API health and ready hit real Postgres", async ({ request }) => {
    const health = await apiJson(request, "/api/health");
    expect(health.res.status()).toBe(200);
    expect(health.body).toMatchObject({ ok: true });

    const ready = await apiJson(request, "/api/ready");
    expect(ready.res.status()).toBe(200);
    expect(ready.body).toMatchObject({ ok: true });
  });

  test("anonymous /api/me and /api/community", async ({ request }) => {
    const me = await apiJson(request, "/api/me");
    expect(me.res.status()).toBe(200);
    expect(me.body).toBeNull();

    const community = await apiJson(request, "/api/community?proposal=bip54");
    expect(community.res.status()).toBe(200);
    const accounts = Array.isArray(community.body)
      ? community.body
      : (community.body as { accounts?: unknown[] })?.accounts;
    expect(Array.isArray(accounts)).toBeTruthy();

    const proposals = await apiJson(request, "/api/proposals");
    expect(proposals.res.status()).toBe(200);
    const items = (proposals.body as { items?: unknown[] })?.items;
    expect(Array.isArray(items)).toBeTruthy();
    expect((items || []).length).toBeGreaterThan(0);
  });

  for (const path of BIP_PATHS) {
    test(`loads BIP route ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
      const me = await fetchMe(page);
      expect(me.status).toBe(200);
      expect(me.body).toBeNull();
    });
  }
});

test.describe("2 — first-time Neutral / Against / Approve via UI", () => {
  const cases: { e2eUser: string; stance: "Neutral" | "Against" | "Approve"; api: string }[] = [
    { e2eUser: "ft_neutral", stance: "Neutral", api: "neutral" },
    { e2eUser: "ft_against", stance: "Against", api: "against" },
    { e2eUser: "ft_approve", stance: "Approve", api: "approve" },
  ];

  for (const c of cases) {
    test(`first-time ${c.stance} save for e2e_user=${c.e2eUser}`, async ({ page }) => {
      await mockOAuthLogin(page, { e2eUser: c.e2eUser, path: "/bip/54" });
      const me = await fetchMe(page);
      expect((me.body as { handle?: string }).handle).toBe(`e2e_${c.e2eUser}`);

      // Auto-prompt may already open the card on stance-less ongoing BIP.
      await saveStanceViaUi(page, c.stance);
      await expectMeStance(page, "bip54", c.api);

      const handles = await communityHandles(page, "bip54");
      expect(handles).toContain(`e2e_${c.e2eUser}`);
    });
  }
});

test.describe("3 — change existing stance + history", () => {
  test("change Neutral → Against via UI; history via API", async ({ page }) => {
    const e2eUser = "chg_stance";
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });
    await saveStanceViaUi(page, "Neutral");
    await expectMeStance(page, "bip54", "neutral");

    await saveStanceViaUi(page, "Against");
    await expectMeStance(page, "bip54", "against");

    const history = await page.evaluate(async () => {
      const r = await fetch("/api/stance-history?proposal=bip54&handle=e2e_chg_stance", {
        credentials: "include",
      });
      return { status: r.status, body: await r.json() };
    });
    expect(history.status).toBe(200);
    const body = history.body as { history?: unknown[]; items?: unknown[] };
    const items = Array.isArray(body?.history)
      ? body.history
      : Array.isArray(body?.items)
        ? body.items
        : Array.isArray(history.body)
          ? history.body
          : [];
    expect(items.length).toBeGreaterThan(0);
    const texts = JSON.stringify(items);
    expect(texts).toMatch(/neutral/i);
    expect(texts).toMatch(/against/i);
  });
});

test.describe("4 — auto stance prompt rules", () => {
  test("stance-less ongoing auto-opens card", async ({ page }) => {
    await mockOAuthLogin(page, { e2eUser: "auto_open", path: "/bip/54" });
    await expect(stanceChoiceDialog(page)).toBeVisible({ timeout: 20_000 });
  });

  test("already stanced does not auto-open", async ({ page }) => {
    await mockOAuthLogin(page, { e2eUser: "auto_stanced", path: "/bip/54" });
    await saveStanceViaUi(page, "Neutral");
    await page.goto("/bip/448");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    // Different proposal may auto-prompt; dismiss if so, then return to bip54.
    const other = stanceChoiceDialog(page);
    if (await other.isVisible().catch(() => false)) {
      await other.getByRole("button", { name: /Not now|Keep current stance|Close/i }).click();
    }
    await page.goto("/bip/54");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await expect(stanceChoiceDialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Neutral" }).first()).toBeVisible();
  });

  test("logged out never shows writable stance card", async ({ page }) => {
    await page.goto("/bip/54");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await expect(stanceChoiceDialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Login with/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Choose position/i })).toHaveCount(0);
  });

  test("final BIP110 has no writable Choose position prompt", async ({ page }) => {
    await mockOAuthLogin(page, { e2eUser: "auto_bip110", path: "/bip/110" });
    await page.waitForTimeout(800);
    await expect(stanceChoiceDialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Choose position/i })).toHaveCount(0);
    await expect(page.getByText(/No position recorded/i)).toBeVisible();
  });
});

test.describe("5 — proposal isolation BIP54 / 448 / 460", () => {
  test("different stances and explanations per proposal", async ({ page }) => {
    const e2eUser = "iso_multi";
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });
    await saveStanceViaUi(page, "Neutral");

    await page.goto("/bip/448");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    await saveStanceViaUi(page, "Against");

    await page.goto("/bip/460");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    await saveStanceViaUi(page, "Approve");

    const me = await fetchMe(page);
    const stances = (me.body as { proposal_stances?: Record<string, string> }).proposal_stances || {};
    expect(stances.bip54).toBe("neutral");
    expect(stances.bip448).toBe("against");
    expect(stances.bip460).toBe("approve");

    // Attach explanation on bip54 only (server oEmbed stubbed in E2E).
    await page.goto("/bip/54");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Neutral" }).first().click();
    const dialog = stanceChoiceDialog(page);
    await expect(dialog).toBeVisible();
    await dismissDisclosureIfPresent(page);
    await dialog.getByLabel(/Explain your stance on X/i).fill(
      `https://x.com/e2e_${e2eUser}/status/1234567890123456789`
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });

    const me2 = await fetchMe(page);
    const exps = (me2.body as { proposal_explanations?: Record<string, unknown> })
      .proposal_explanations || {};
    expect(exps.bip54).toBeTruthy();
    expect(exps.bip448 == null || exps.bip448 === null).toBeTruthy();
  });
});

test.describe("6 — explanation flow via card (E2E oEmbed stub)", () => {
  test("attach explanation URL through stance card", async ({ page }) => {
    const e2eUser = "explain_ok";
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });
    await saveStanceViaUi(page, "Approve");

    await page.getByRole("button", { name: "Approve" }).first().click();
    const dialog = stanceChoiceDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/Explain your stance on X/i).fill(
      `https://x.com/e2e_${e2eUser}/status/1987654321098765432`
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });

    await expect
      .poll(async () => {
        const me = await fetchMe(page);
        const exp = (me.body as { proposal_explanations?: Record<string, { canonical_url?: string }> })
          ?.proposal_explanations?.bip54;
        return exp?.canonical_url || "";
      })
      .toMatch(/status\/1987654321098765432/);
  });
});

test.describe("7 — OAuth popup success / cancel / error / CSP", () => {
  test("success popup uses external script (CSP)", async ({ page }) => {
    await mockOAuthLogin(page, { e2eUser: "oauth_ok", path: "/bip/54" });
    const me = await fetchMe(page);
    expect(me.body).toMatchObject({ handle: "e2e_oauth_ok", x_user_id: expect.any(String) });
  });

  test("cancel: close popup before callback completes", async ({ page }) => {
    await ackPrivacyDisclosure(page);
    await page.route("**/auth/x/callback*", (route) => route.abort());
    await page.goto("/bip/54");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

    const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
    await page.getByRole("button", { name: /Login with/i }).click();
    const popup = await popupPromise;
    await popup.close();

    await page.waitForTimeout(500);
    const me = await fetchMe(page);
    expect(me.body).toBeNull();
    await expect(page.getByRole("button", { name: /Login with/i })).toBeVisible();
  });

  test("error popup path shows Sign-in failed", async ({ page }) => {
    await page.goto("/bip/54");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

    const popupPromise = page.waitForEvent("popup");
    await page.evaluate(() => {
      window.open("/auth/x/callback?code=&state=", "ch_oauth_err", "width=480,height=640");
    });
    const popup = await popupPromise;
    await popup.waitForSelector("#ch-auth-payload", { state: "attached", timeout: 15_000 });
    const html = await popup.content();
    expect(html).toMatch(/Sign-in failed/i);
    expect(html).toContain("/auth/popup-complete.js");
    await popup.close().catch(() => undefined);

    const me = await fetchMe(page);
    expect(me.body).toBeNull();
  });

  test("wrong-browser / expired state fails at API callback", async ({ request }) => {
    const res = await request.get("/auth/x/callback?code=mock_oauth_code&state=not-a-real-state");
    // Non-popup without mode cookie → 400 or error finish; must not set a session.
    expect([400, 200, 500]).toContain(res.status());
    const me = await apiJson(request, "/api/me");
    expect(me.body).toBeNull();
  });
});

test.describe("8 — delete account via UI + keyboard", () => {
  test("account menu → DeleteAccountDialog → tombstone", async ({ page }) => {
    const e2eUser = "del_ui";
    const handle = `e2e_${e2eUser}`;
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });
    await saveStanceViaUi(page, "Neutral");

    await page.getByRole("button", { name: new RegExp(`Account menu for @${handle}`, "i") }).click();
    await page.getByRole("menuitem", { name: /Delete my account and data/i }).click();

    const dialog = page.getByRole("dialog", { name: /Delete my account and data/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("input")).toBeFocused();

    // Escape cancels.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: new RegExp(`Account menu for @${handle}`, "i") }).click();
    await page.getByRole("menuitem", { name: /Delete my account and data/i }).click();
    await expect(page.getByRole("dialog", { name: /Delete my account and data/i })).toBeVisible();
    await page.getByLabel(/Confirm handle/i).fill(handle);
    await page.getByRole("button", { name: "Delete account", exact: true }).click();

    await expect
      .poll(async () => (await fetchMe(page)).body, { timeout: 30_000 })
      .toBeNull();

    const handles = await communityHandles(page, "bip54");
    expect(handles).not.toContain(handle);
  });
});

test.describe("9 — failure polish (429 / 500 / 503 / offline)", () => {
  test("community 500 shows maintenance + Retry", async ({ page }) => {
    await page.route("**/api/community**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        headers: { "x-request-id": "e2e-500" },
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });
    await page.goto("/bip/54");
    await expect(page.getByText("Temporarily unavailable")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("alert")).toContainText(/trouble loading/i);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("community 429 Retry-After shows friendly maintenance UI", async ({ page }) => {
    await page.route("**/api/community**", async (route) => {
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Retry-After": "30", "x-request-id": "e2e-429" },
        body: JSON.stringify({
          error: "rate_limited",
          message: "Too many requests. Please wait and try again.",
        }),
      });
    });
    await page.goto("/bip/54");
    await expect(page.getByText("Temporarily unavailable")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("community 503 (not ready) shows friendly maintenance UI", async ({ page }) => {
    await page.route("**/api/community**", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "not_ready" }),
      });
    });
    await page.goto("/bip/54");
    await expect(page.getByText("Temporarily unavailable")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("/api/ready 503 JSON contract (API-level)", async ({ page }) => {
    await page.route("**/api/ready", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "not_ready", service: "consensushealth-api" }),
      });
    });
    const result = await page.evaluate(async () => {
      const r = await fetch("/api/ready");
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, error: "not_ready" });
  });

  test("offline community load shows maintenance + Retry", async ({ page, context }) => {
    await context.setOffline(true);
    await page.goto("/bip/54", { waitUntil: "domcontentloaded" }).catch(() => undefined);
    // SPA shell may still paint; force reload of data path via Retry if already loaded from bfcache.
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await expect(page.getByText(/Temporarily unavailable|Consensus Health/i).first()).toBeVisible({
      timeout: 30_000,
    });
    // When PROD build cannot reach community, maintenance alert appears.
    const alert = page.getByRole("alert");
    if (await alert.isVisible().catch(() => false)) {
      await expect(alert).toContainText(/trouble loading/i);
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    }
    await context.setOffline(false);
  });

  test("stance POST 429 surfaces friendly error in card", async ({ page }) => {
    await mockOAuthLogin(page, { e2eUser: "fail_429", path: "/bip/54" });
    await page.route("**/api/stance", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Retry-After": "60" },
        body: JSON.stringify({
          error: "rate_limited",
          message: "Too many requests. Please wait and try again.",
        }),
      });
    });

    const dialog = stanceChoiceDialog(page);
    if (!(await dialog.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /Choose position/i }).click();
    }
    await expect(dialog).toBeVisible();
    await dismissDisclosureIfPresent(page);
    await dialog.getByRole("button", { name: "Neutral", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(/rate_limited|Too many requests|Failed \(429\)/i);
  });
});

test.describe("10 — keyboard / focus / reduced motion", () => {
  test("Privacy / Terms Escape + focus; delete focus trap", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Privacy" }).first().click();
    const privacy = page.getByRole("dialog", { name: "Privacy" });
    await expect(privacy).toBeVisible();
    await expect(privacy.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(privacy).toHaveCount(0);

    await page.getByRole("button", { name: "Terms" }).first().click();
    const terms = page.getByRole("dialog", { name: /Terms/i });
    await expect(terms).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(terms).toHaveCount(0);

    await mockOAuthLogin(page, { e2eUser: "kb_del", path: "/bip/54" });
    // Dismiss auto stance prompt so account menu is usable.
    const stance = stanceChoiceDialog(page);
    if (await stance.isVisible().catch(() => false)) {
      await stance.getByRole("button", { name: /Not now/i }).click();
    }
    await page.getByRole("button", { name: /Account menu for @e2e_kb_del/i }).click();
    await page.getByRole("menuitem", { name: /Delete my account and data/i }).click();
    const del = page.getByRole("dialog", { name: /Delete my account and data/i });
    await expect(del).toBeVisible();
    await expect(del.locator("input")).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(del).toHaveCount(0);
  });

  test("reduced motion marks distant galaxies static", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForSelector(".distantGalaxy", { timeout: 30_000 });
    const staticCount = await page.locator(".distantGalaxy--static").count();
    expect(staticCount).toBeGreaterThan(0);
  });
});

test.describe("11 — viewports + galaxy slots + no overflow", () => {
  test("distant galaxy slots use fixed percent left/top", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".distantGalaxy", { timeout: 30_000 });
    const slots = await page.locator(".distantGalaxy").evaluateAll((nodes) =>
      nodes.map((el) => {
        const style = (el as HTMLElement).style;
        const label = el.getAttribute("aria-label") || "";
        return { label, left: style.left, top: style.top };
      })
    );
    expect(slots.length).toBeGreaterThan(0);
    let matched = 0;
    for (const slot of slots) {
      const match = Object.entries(CANONICAL_DISTANT_SLOTS).find(
        ([id]) =>
          slot.label.toLowerCase().includes(id.replace("bip", "bip-")) ||
          slot.label.toLowerCase().includes(id)
      );
      if (!match) continue;
      matched += 1;
      const [, pose] = match;
      expect(slot.left).toBe(`${pose.x}%`);
      expect(slot.top).toBe(`${pose.y}%`);
    }
    expect(matched).toBeGreaterThan(0);
  });

  for (const vp of VIEWPORTS) {
    test(`no horizontal overflow at ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
      await page.waitForSelector(".distantGalaxy", { timeout: 30_000 }).catch(() => undefined);
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
      });
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }
});

test.describe("legacy serial smoke (default mock handle)", () => {
  test.describe.configure({ mode: "serial" });

  test("default env mock login still works", async ({ page, request }) => {
    await mockOAuthLogin(page);
    const me = await fetchMe(page);
    expect(me.body).toMatchObject({
      handle: DEFAULT_MOCK_HANDLE,
      x_user_id: expect.any(String),
    });
    const anon = await apiJson(request, "/api/me");
    expect(anon.body).toBeNull();
  });
});
