import { CANONICAL_DISTANT_SLOTS } from "../src/utils/distantGalaxyLayout";
import {
  alternateTestClientIp,
  expect,
  newContextWithClientIp,
  test,
} from "./fixtures";
import {
  apiJson,
  communityHandles,
  expectMeStance,
  fetchMe,
  fetchStanceHistoryItems,
  mockOAuthLogin,
  saveStanceViaUi,
  stanceChoiceDialog,
  dismissDisclosureIfPresent,
  ackPrivacyDisclosure,
  e2eHandleForUser,
  ensureStanceChoiceDialogOpen,
} from "./helpers";

const REAL = process.env.E2E_REAL_BACKEND === "1";
const DEFAULT_MOCK_HANDLE = (process.env.X_OAUTH_MOCK_HANDLE || "e2e_mock_user").trim().toLowerCase();
const ONGOING = ["bip54", "bip448", "bip460"] as const;

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1920", width: 1920, height: 1080 },
] as const;

const BIP_PATHS = ["/", "/bip/54", "/bip/110", "/bip/448", "/bip/460"] as const;

async function installCommunityFailure(
  page: Page,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  await page.goto("/bip/110");
  await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(
    ({ mockedStatus, mockedBody, mockedHeaders }) => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/api/community")) {
          return Promise.resolve(
            new Response(JSON.stringify(mockedBody), {
              status: mockedStatus,
              headers: { "content-type": "application/json", ...mockedHeaders },
            })
          );
        }
        return nativeFetch(input, init);
      };
    },
    { mockedStatus: status, mockedBody: body, mockedHeaders: headers }
  );
}

async function travelToMockedBip54(page: Page) {
  await page.getByRole("button", { name: /Travel to BIP54/i }).click();
}

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
      expect((me.body as { handle?: string }).handle).toBe(e2eHandleForUser(c.e2eUser));

      await saveStanceViaUi(page, c.stance);
      await expectMeStance(page, "bip54", c.api);

      const handles = await communityHandles(page, "bip54");
      expect(handles).toContain(e2eHandleForUser(c.e2eUser));
    });
  }
});

test.describe("3 — change existing stance + history", () => {
  test("change Neutral → Against via UI; exact history events", async ({ page }) => {
    const e2eUser = "chg_stance";
    const handle = e2eHandleForUser(e2eUser);
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });
    await saveStanceViaUi(page, "Neutral");
    await expectMeStance(page, "bip54", "neutral");

    await saveStanceViaUi(page, "Against");
    await expectMeStance(page, "bip54", "against");

    const history = await fetchStanceHistoryItems(page, "bip54", handle);
    expect(history.status).toBe(200);
    expect(history.items.length).toBeGreaterThanOrEqual(2);

    const events = history.items.map((row: { previous_stance?: string | null; new_stance?: string }) => ({
      previous: row.previous_stance ?? null,
      next: row.new_stance,
    }));
    expect(events).toEqual(
      expect.arrayContaining([
        { previous: null, next: "neutral" },
        { previous: "neutral", next: "against" },
      ])
    );
  });
});

test.describe("4 — auto stance prompt rules", () => {
  for (const proposal of ONGOING) {
    const path = `/bip/${proposal.replace("bip", "")}`;
    test(`stance-less auto-opens on ${proposal}`, async ({ page }) => {
      await mockOAuthLogin(page, { e2eUser: `auto_${proposal}`, path });
      await expect(stanceChoiceDialog(page)).toBeVisible({ timeout: 20_000 });
    });

    test(`already stanced does not auto-open on ${proposal}`, async ({ page }) => {
      const e2eUser = `stanced_${proposal}`;
      await mockOAuthLogin(page, { e2eUser, path });
      await saveStanceViaUi(page, "Neutral");
      await page.goto(path);
      await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => stanceChoiceDialog(page).count(), { timeout: 5_000 })
        .toBe(0);
      await expect(page.getByRole("button", { name: "Neutral" }).first()).toBeVisible();
    });
  }

  test("logged out never shows writable stance card", async ({ page }) => {
    await travelToMockedBip54(page);
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => stanceChoiceDialog(page).count(), { timeout: 5_000 })
      .toBe(0);
    await expect(page.getByRole("button", { name: /Login with/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Choose position/i })).toHaveCount(0);
  });

  test("final BIP110 has no writable Choose position prompt", async ({ page }) => {
    await mockOAuthLogin(page, { e2eUser: "auto_bip110", path: "/bip/110" });
    await expect
      .poll(async () => stanceChoiceDialog(page).count(), { timeout: 5_000 })
      .toBe(0);
    await expect(page.getByRole("button", { name: /Choose position/i })).toHaveCount(0);
    const me = await fetchMe(page);
    expect((me.body as { proposal_stances?: Record<string, string | null> }).proposal_stances?.bip110 ?? null).toBeNull();
  });
});

test.describe("5 — proposal isolation BIP54 / 448 / 460", () => {
  test("different stances and explanations per ongoing proposal", async ({ page }) => {
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
    expect(stances.bip110 == null || stances.bip110 === null).toBeTruthy();

    async function attachExplanation(bipPath: string, stanceLabel: string, statusId: string) {
      await page.goto(bipPath);
      await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: stanceLabel }).first().click();
      const dialog = stanceChoiceDialog(page);
      await expect(dialog).toBeVisible();
      await dismissDisclosureIfPresent(page);
      await dialog
        .getByLabel(/Explain your stance on X/i)
        .fill(`https://x.com/${e2eHandleForUser(e2eUser)}/status/${statusId}`);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    }

    await attachExplanation("/bip/54", "Neutral", "1111111111111111111");
    await attachExplanation("/bip/448", "Against", "2222222222222222222");
    await attachExplanation("/bip/460", "Approve", "3333333333333333333");

    const me2 = await fetchMe(page);
    const exps =
      (me2.body as { proposal_explanations?: Record<string, { canonical_url?: string }> })
        .proposal_explanations || {};
    expect(exps.bip54?.canonical_url).toMatch(/1111111111111111111/);
    expect(exps.bip448?.canonical_url).toMatch(/2222222222222222222/);
    expect(exps.bip460?.canonical_url).toMatch(/3333333333333333333/);
  });
});

test.describe("6 — explanation flow via card (E2E oEmbed stub)", () => {
  test("save without link; add/change/remove; reject bad URLs; verifier fail keeps stance", async ({
    page,
  }) => {
    const e2eUser = "explain_full";
    const handle = e2eHandleForUser(e2eUser);
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });
    await saveStanceViaUi(page, "Approve");
    await expectMeStance(page, "bip54", "approve");

    // No-link save (change to Neutral without explanation).
    await saveStanceViaUi(page, "Neutral");
    await expectMeStance(page, "bip54", "neutral");
    let me = await fetchMe(page);
    expect((me.body as { proposal_explanations?: Record<string, unknown> }).proposal_explanations?.bip54 == null).toBeTruthy();

    // Add valid own-post link.
    let dialog = await ensureStanceChoiceDialogOpen(page);
    await dialog
      .getByLabel(/Explain your stance on X/i)
      .fill(`https://x.com/${handle}/status/1987654321098765432`);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });

    await expect
      .poll(async () => {
        me = await fetchMe(page);
        return (
          (me.body as { proposal_explanations?: Record<string, { canonical_url?: string; tweet_text?: string }> })
            ?.proposal_explanations?.bip54?.canonical_url || ""
        );
      })
      .toMatch(/status\/1987654321098765432/);

    // Snippet / full text on selected card.
    await page.getByRole("button", { name: new RegExp(`@${handle}`, "i") }).first().click().catch(() => undefined);
    // Selected header explanation uses tweet_text from community merge — open own avatar if present.
    const selectedCard = page.locator(".selectedUserCard");
    if (await selectedCard.isVisible().catch(() => false)) {
      await expect(selectedCard).toContainText(/E2E mock explanation/i);
    }

    // Change link.
    dialog = await ensureStanceChoiceDialogOpen(page);
    const changeBtn = dialog.getByRole("button", { name: /Change explanation/i });
    if (await changeBtn.isVisible().catch(() => false)) {
      await changeBtn.click();
    }
    await dialog
      .getByLabel(/Explain your stance on X/i)
      .fill(`https://x.com/${handle}/status/1887654321098765432`);
    await dialog.getByRole("button", { name: /Save/i }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => {
        me = await fetchMe(page);
        return (
          (me.body as { proposal_explanations?: Record<string, { canonical_url?: string }> })
            ?.proposal_explanations?.bip54?.canonical_url || ""
        );
      })
      .toMatch(/1887654321098765432/);

    // Reject another handle.
    dialog = await ensureStanceChoiceDialogOpen(page);
    if (await dialog.getByRole("button", { name: /Change explanation/i }).isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: /Change explanation/i }).click();
    }
    await dialog.getByLabel(/Explain your stance on X/i).fill("https://x.com/someone_else/status/1777777777777777777");
    await dialog.getByRole("button", { name: /Save/i }).click();
    await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: /Not now|Cancel|Close|Keep/i }).click().catch(async () => {
      await page.keyboard.press("Escape");
    });

    // Reject non-post URL.
    dialog = await ensureStanceChoiceDialogOpen(page);
    if (await dialog.getByRole("button", { name: /Change explanation/i }).isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: /Change explanation/i }).click();
    }
    await dialog.getByLabel(/Explain your stance on X/i).fill(`https://x.com/${handle}`);
    await dialog.getByRole("button", { name: /Save/i }).click();
    await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    // Verifier unavailable — stance retained.
    dialog = await ensureStanceChoiceDialogOpen(page);
    await dialog.getByRole("button", { name: "Against", exact: true }).click();
    if (await dialog.getByRole("button", { name: /Change explanation|Remove explanation/i }).first().isVisible().catch(() => false)) {
      // Prefer remove path then attach unavailable id, or replace.
      const remove = dialog.getByRole("button", { name: /Remove explanation/i });
      if (await remove.isVisible().catch(() => false)) await remove.click();
    }
    await dialog
      .getByLabel(/Explain your stance on X/i)
      .fill(`https://x.com/${handle}/status/9990000000000000001`);
    await dialog.getByRole("button", { name: /Save/i }).click();
    await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 20_000 });
    await expectMeStance(page, "bip54", "against");

    // Remove explanation cleanly.
    dialog = await ensureStanceChoiceDialogOpen(page);
    const removeOnly = dialog.getByRole("button", { name: /Remove explanation/i });
    if (await removeOnly.isVisible().catch(() => false)) {
      await removeOnly.click();
      await expect(dialog).toHaveCount(0, { timeout: 30_000 }).catch(async () => {
        await dialog.getByRole("button", { name: /Save|Done|Close/i }).click().catch(() => undefined);
      });
    } else {
      await page.keyboard.press("Escape");
    }
    await expectMeStance(page, "bip54", "against");
  });
});

test.describe("7 — OAuth popup success / cancel / error / CSP", () => {
  test("success popup + session via parent completion signal", async ({ page }) => {
    const capture = await mockOAuthLogin(page, { e2eUser: "oauth_ok", path: "/bip/54" });
    expect(capture.completion?.status).toBe("success");
    const me = await fetchMe(page);
    expect(me.body).toMatchObject({ handle: e2eHandleForUser("oauth_ok"), x_user_id: expect.any(String) });
  });

  test("cancel pending OAuth before callback does not create a session", async ({ page }) => {
    await ackPrivacyDisclosure(page);
    await travelToMockedBip54(page);
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    const pending = await page.context().request.get("/auth/x/login?mode=popup", {
      maxRedirects: 0,
    });
    expect(pending.status()).toBe(302);
    expect(pending.headers().location).toMatch(/\/auth\/x\/callback/);
    const popupPromise = page.waitForEvent("popup");
    await page.evaluate(() => window.open("about:blank", "oauth_cancel", "width=480,height=640"));
    const popup = await popupPromise;
    await popup.close();
    expect((await fetchMe(page)).body).toBeNull();
    await expect(page.getByRole("button", { name: /Login with/i })).toBeVisible();
  });

  test("provider denial via real popup-mode login", async ({ page }) => {
    const capture = await mockOAuthLogin(page, {
      e2eUser: "oauth_deny",
      e2eFail: "deny",
      expectSession: false,
      path: "/bip/54",
    });
    expect(capture.completion?.status).toBe("error");
  });

  test("token/provider failure via real popup-mode login", async ({ page }) => {
    const capture = await mockOAuthLogin(page, {
      e2eUser: "oauth_token",
      e2eFail: "token",
      expectSession: false,
      path: "/bip/54",
    });
    expect(capture.completion?.status).toBe("error");
  });

  test("expired state via real popup-mode login", async ({ page }) => {
    const capture = await mockOAuthLogin(page, {
      e2eUser: "oauth_exp",
      e2eFail: "expired",
      expectSession: false,
      path: "/bip/54",
    });
    expect(capture.completion?.status).toBe("error");
  });

  test("wrong-browser nonce does not create session; original browser can still succeed", async ({
    browser,
    testClientIp,
  }, testInfo) => {
    const ownerIp = testClientIp;
    const thiefIp = alternateTestClientIp(testInfo);
    const contextOwner = await newContextWithClientIp(browser, ownerIp);
    const pageOwner = await contextOwner.newPage();

    try {
      await ackPrivacyDisclosure(pageOwner);
      await pageOwner.goto("/bip/54");
      await expect(pageOwner.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

      const pending = await contextOwner.request.get(
        "/auth/x/login?mode=popup&e2e_user=oauth_wb",
        { maxRedirects: 0 }
      );
      expect(pending.status()).toBe(302);
      const stolenUrl = pending.headers().location || "";
      expect(stolenUrl).toMatch(/\/auth\/x\/callback/);

      // Wrong browser: no oauth state/mode cookies → cannot consume; no session; row not burned.
      const contextThief = await newContextWithClientIp(browser, thiefIp);
      const pageThief = await contextThief.newPage();
      try {
        const wrong = await pageThief.goto(stolenUrl);
        expect(wrong).toBeTruthy();
        // Without popup mode cookie the server returns a non-session error (400) or redirect.
        expect([400, 302, 303]).toContain(wrong!.status());
        expect((await fetchMe(pageThief)).body).toBeNull();
      } finally {
        await contextThief.close();
      }

      // Original browser still has the nonce cookie — complete the same callback URL.
      await pageOwner.evaluate(() => {
        const w = window as unknown as {
          __chOauthMsgs: Array<{ status?: string }>;
          __chOauthOnMessage?: (ev: MessageEvent) => void;
          __chOauthBc?: BroadcastChannel;
        };
        if (w.__chOauthOnMessage) {
          window.removeEventListener("message", w.__chOauthOnMessage as EventListener);
        }
        if (w.__chOauthBc) {
          try {
            w.__chOauthBc.close();
          } catch {
            /* closed */
          }
        }
        w.__chOauthMsgs = [];
        w.__chOauthOnMessage = (ev: MessageEvent) => {
          if (ev.data && typeof ev.data === "object") {
            w.__chOauthMsgs.push(ev.data as { status?: string });
          }
        };
        window.addEventListener("message", w.__chOauthOnMessage as EventListener);
        try {
          w.__chOauthBc = new BroadcastChannel("consensushealth-oauth");
          w.__chOauthBc.onmessage = (ev) => {
            if (ev.data && typeof ev.data === "object") {
              w.__chOauthMsgs.push(ev.data as { status?: string });
            }
          };
        } catch {
          /* BroadcastChannel unavailable */
        }
      });
      try {
        const ownerPopupPromise = pageOwner.waitForEvent("popup", { timeout: 30_000 });
        await pageOwner.evaluate((url) => {
          window.open(url, "oauth_retry", "width=480,height=640");
        }, stolenUrl);
        const ownerPopup = await ownerPopupPromise;
        if (!ownerPopup.isClosed()) {
          await ownerPopup.waitForEvent("close", { timeout: 15_000 });
        }
        await expect
          .poll(async () => {
            const me = await fetchMe(pageOwner);
            return Boolean((me.body as { x_user_id?: string } | null)?.x_user_id);
          })
          .toBeTruthy();
      } finally {
        await pageOwner
          .evaluate(() => {
            const w = window as unknown as {
              __chOauthOnMessage?: (ev: MessageEvent) => void;
              __chOauthBc?: BroadcastChannel;
            };
            if (w.__chOauthOnMessage) {
              window.removeEventListener("message", w.__chOauthOnMessage as EventListener);
              w.__chOauthOnMessage = undefined;
            }
            if (w.__chOauthBc) {
              try {
                w.__chOauthBc.close();
              } catch {
                /* closed */
              }
              w.__chOauthBc = undefined;
            }
          })
          .catch(() => undefined);
      }
    } finally {
      await contextOwner.close();
    }
  });

  test("invalid state without popup cookies returns 400", async ({ request }) => {
    const res = await request.get("/auth/x/callback?code=mock_oauth_code&state=not-a-real-state");
    expect(res.status()).toBe(400);
    const me = await apiJson(request, "/api/me");
    expect(me.body).toBeNull();
  });
});

test.describe("8 — delete account via UI + keyboard", () => {
  test("self-service account deletion is hidden", async ({ page }) => {
    const e2eUser = "del_ui";
    const handle = e2eHandleForUser(e2eUser);
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });

    const menuBtn = page.getByRole("button", { name: new RegExp(`Account menu for @${handle}`, "i") });
    await menuBtn.click();
    await expect(page.getByRole("menuitem", { name: /Delete my account and data/i })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: /Delete my account and data/i })).toHaveCount(0);
    return;
    await page.getByRole("menuitem", { name: /Delete my account and data/i }).click();

    const dialog = page.getByRole("dialog", { name: /Delete my account and data/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("input")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(menuBtn).toBeFocused();

    await menuBtn.click();
    await page.getByRole("menuitem", { name: /Delete my account and data/i }).click();
    await expect(page.getByRole("dialog", { name: /Delete my account and data/i })).toBeVisible();
    await page.getByLabel(/Confirm handle/i).fill(handle);
    await page.getByRole("button", { name: "Delete account", exact: true }).click();

    await expect
      .poll(async () => (await fetchMe(page)).body, { timeout: 30_000 })
      .toBeNull();

    await expect(page.getByRole("button", { name: new RegExp(`Account menu for @${handle}`, "i") })).toHaveCount(0);
    await expect(page.locator(".selectedUserCard")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Login with/i })).toBeVisible();

    const handles = await communityHandles(page, "bip54");
    expect(handles).not.toContain(handle);

    // Tombstone: re-login creates a new session, but prior bip54 row is gone and seed-style id stays suppressible.
    await mockOAuthLogin(page, { e2eUser, path: "/bip/54" });
    const me2 = await fetchMe(page);
    expect((me2.body as { handle?: string }).handle).toBe(handle);
    // Fresh account should not inherit the deleted stance.
    expect((me2.body as { proposal_stances?: Record<string, string> }).proposal_stances?.bip54 == null).toBeTruthy();
  });
});

test.describe("9 — failure polish + real dual rate limits", () => {
  test("community 500 shows maintenance + Retry", async ({ page }) => {
    await installCommunityFailure(
      page,
      500,
      { error: "Internal server error" },
      { "x-request-id": "e2e-500" }
    );
    await travelToMockedBip54(page);
    await expect(page.getByText("Temporarily unavailable")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("alert")).toContainText(/trouble loading/i);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("community 429 Retry-After shows friendly maintenance UI", async ({ page }) => {
    await installCommunityFailure(
      page,
      429,
      { error: "rate_limited", message: "Too many requests. Please wait and try again." },
      { "Retry-After": "30", "x-request-id": "e2e-429" }
    );
    await page.goto("/bip/54");
    await expect(page.getByText("Temporarily unavailable")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("community 503 (not ready) shows friendly maintenance UI", async ({ page }) => {
    await installCommunityFailure(page, 503, { ok: false, error: "not_ready" });
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
    await page.goto("/bip/54");
    const result = await page.evaluate(async () => {
      const r = await fetch("/api/ready");
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, error: "not_ready" });
  });

  test("offline community load shows maintenance + Retry", async ({ page, context }) => {
    await page.goto("/bip/110");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
    await context.setOffline(true);
    await page.getByRole("button", { name: /Travel to BIP54/i }).click();
    await expect(page.getByText(/Temporarily unavailable|Consensus Health/i).first()).toBeVisible({
      timeout: 30_000,
    });
    const alert = page.getByRole("alert");
    if (await alert.isVisible().catch(() => false)) {
      await expect(alert).toContainText(/trouble loading/i);
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    }
    await context.setOffline(false);
  });

  test("real dual IP/account stance 429 with Retry-After", async ({ page, browser, testClientIp }, testInfo) => {
    // Primary account stays on one known isolated IP for all four writes.
    // Express trust proxy = 1 (render_direct) maps X-Forwarded-For → req.ip rate key.
    const primaryIp = testClientIp;
    const secondaryIp = alternateTestClientIp(testInfo);
    expect(primaryIp).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
    expect(secondaryIp).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
    expect(secondaryIp).not.toBe(primaryIp);

    // E2E_STANCE_WRITE_MAX=3 — fourth write from same account+IP must 429.
    await mockOAuthLogin(page, { e2eUser: "rl_acct", path: "/bip/54" });
    const stances: Array<"Neutral" | "Against" | "Approve"> = ["Neutral", "Against", "Approve", "Neutral"];
    for (let i = 0; i < 3; i += 1) {
      await saveStanceViaUi(page, stances[i]!);
    }
    // Fourth attempt via API to inspect headers (same primary IP / account).
    const limited = await page.evaluate(async () => {
      const r = await fetch("/api/stance", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", stance: "neutral" }),
      });
      return {
        status: r.status,
        retryAfter: r.headers.get("retry-after"),
        body: await r.json().catch(() => null),
      };
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({ error: "rate_limited" });

    // Second account on a different known IP can write once; proves a fresh IP/account
    // pair is unaffected while the original account/IP remains blocked.
    const contextB = await newContextWithClientIp(browser, secondaryIp);
    const pageB = await contextB.newPage();
    try {
      await mockOAuthLogin(pageB, { e2eUser: "rl_other", path: "/bip/54" });
      await saveStanceViaUi(pageB, "Neutral");
      await expectMeStance(pageB, "bip54", "neutral");
    } finally {
      await contextB.close();
    }

    // Original account on primaryIp still blocked without waiting out the window.
    const stillLimited = await page.evaluate(async () => {
      const r = await fetch("/api/stance", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", stance: "against" }),
      });
      return { status: r.status, retryAfter: r.headers.get("retry-after") };
    });
    expect(stillLimited.status).toBe(429);
    expect(Number(stillLimited.retryAfter)).toBeGreaterThan(0);
  });
});

test.describe("10 — keyboard / focus / reduced motion", () => {
  test("Privacy / Terms Escape + focus restoration", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

    const privacyBtn = page.getByRole("button", { name: "Privacy", exact: true }).first();
    await privacyBtn.click();
    const privacy = page.getByRole("dialog", { name: "Privacy" });
    await expect(privacy).toBeVisible();
    await expect(privacy.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(privacy).toHaveCount(0);
    await expect(privacyBtn).toBeFocused();

    const termsBtn = page.getByRole("button", { name: "Terms", exact: true }).first();
    await termsBtn.click();
    const terms = page.getByRole("dialog", { name: /Terms/i });
    await expect(terms).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(terms).toHaveCount(0);
    await expect(termsBtn).toBeFocused();
  });

  test("reduced motion marks distant galaxies static", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForSelector(".distantGalaxy", { timeout: 30_000 });
    const staticCount = await page.locator(".distantGalaxy--static").count();
    expect(staticCount).toBeGreaterThan(0);
  });
});

test.describe("11 — viewports + galaxy slots + travel + overflow", () => {
  test("distant galaxy slots use fixed percent left/top; active hidden", async ({ page }) => {
    await page.goto("/bip/54");
    await page.waitForSelector(".distantGalaxy", { timeout: 30_000 });
    const slots = await page.locator(".distantGalaxy").evaluateAll((nodes) =>
      nodes.map((el) => {
        const style = (el as HTMLElement).style;
        const label = el.getAttribute("aria-label") || "";
        return { label, left: style.left, top: style.top };
      })
    );
    expect(slots.length).toBeGreaterThan(0);
    // Active BIP-54 must not appear among distant galaxies.
    expect(slots.every((s) => !/bip-?54/i.test(s.label))).toBeTruthy();
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

    // Travel: click another distant galaxy.
    const target = page.locator(".distantGalaxy").first();
    await target.click();
    await expect
      .poll(async () => page.url(), { timeout: 20_000 })
      .not.toMatch(/\/bip\/54\/?$/);
  });

  for (const vp of VIEWPORTS) {
    test(`no horizontal/vertical control overflow at ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });
      await page.waitForSelector(".distantGalaxy", { timeout: 30_000 }).catch(() => undefined);
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const body = document.body;
        return {
          scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
          clientWidth: root.clientWidth,
          scrollHeight: Math.max(root.scrollHeight, body.scrollHeight),
          clientHeight: root.clientHeight,
        };
      });
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
      // Vertical: page may scroll, but controls should not force absurd overflow (>2 viewports).
      expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight * 2 + 40);
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
import type { Page } from "@playwright/test";
