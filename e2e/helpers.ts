import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";

export type StanceUiLabel = "Neutral" | "Against" | "Approve";

export async function apiJson(
  request: APIRequestContext,
  path: string,
  init?: Parameters<APIRequestContext["fetch"]>[1]
) {
  const res = await request.fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

export async function fetchMe(page: Page) {
  return page.evaluate(async () => {
    const r = await fetch("/api/me", { credentials: "include" });
    return { status: r.status, body: await r.json() };
  });
}

export async function ackPrivacyDisclosure(page: Page) {
  await page.evaluate(() => {
    try {
      localStorage.setItem("ch_privacy_disclosure_v1", "1");
    } catch {
      /* ignore */
    }
  });
}

/** Rewrite /auth/x/login to attach ?e2e_user= for per-context mock identities. */
export async function attachE2EUserLoginRoute(page: Page, e2eUser: string) {
  await page.route("**/auth/x/login*", async (route: Route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("e2e_user", e2eUser);
    await route.continue({ url: url.toString() });
  });
}

/**
 * Complete mock OAuth via the real popup login route (helmet CSP + popup-complete.js).
 * Pass e2eUser for an isolated mock identity (requires CONSENSUSHEALTH_E2E=1).
 */
export async function mockOAuthLogin(page: Page, opts?: { e2eUser?: string; path?: string }) {
  const path = opts?.path || "/bip/54";
  if (opts?.e2eUser) {
    await attachE2EUserLoginRoute(page, opts.e2eUser);
  }
  await ackPrivacyDisclosure(page);
  await page.goto(path);
  await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await page.getByRole("button", { name: /Login with/i }).click();
  const popup = await popupPromise;

  await popup.waitForSelector("#ch-auth-payload", { state: "attached", timeout: 30_000 });
  const popupHtml = await popup.content();
  expect(popupHtml).toMatch(/Signed in/i);
  expect(popupHtml).toContain("/auth/popup-complete.js");
  expect(popupHtml).toContain('id="ch-auth-payload"');
  expect(popupHtml).toMatch(
    /type="application\/json"[^>]*id="ch-auth-payload"|id="ch-auth-payload"[^>]*type="application\/json"/
  );

  await popup.waitForEvent("close", { timeout: 30_000 }).catch(async () => {
    await popup.close();
  });

  await expect
    .poll(
      async () => {
        const me = await fetchMe(page);
        return Boolean(me.body && typeof me.body === "object" && (me.body as { x_user_id?: string }).x_user_id);
      },
      { timeout: 30_000 }
    )
    .toBeTruthy();
}

export function stanceChoiceDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByRole("group", { name: "Stance options" }) });
}

export async function dismissDisclosureIfPresent(page: Page) {
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) {
    await gotIt.click();
  }
}

/** Open stance card if needed, pick stance, Save (first-time or change). */
export async function saveStanceViaUi(page: Page, stance: StanceUiLabel) {
  const dialog = stanceChoiceDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) {
    const openBtn = page
      .getByRole("button", { name: /Choose position|Neutral|Against|Approve|Change your position/i })
      .first();
    await openBtn.click();
  }
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dismissDisclosureIfPresent(page);
  await dialog.getByRole("button", { name: stance, exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

export async function expectMeStance(page: Page, proposalId: string, stance: string) {
  await expect
    .poll(
      async () => {
        const me = await fetchMe(page);
        const body = me.body as { proposal_stances?: Record<string, string> } | null;
        return body?.proposal_stances?.[proposalId] ?? null;
      },
      { timeout: 30_000 }
    )
    .toBe(stance);
}

export async function communityHandles(page: Page, proposal: string): Promise<string[]> {
  return page.evaluate(async (p) => {
    const r = await fetch(`/api/community?proposal=${encodeURIComponent(p)}`, { credentials: "include" });
    const data = await r.json();
    const accounts = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [];
    return accounts.map((u: { handle?: string }) =>
      String(u.handle || "")
        .trim()
        .toLowerCase()
    );
  }, proposal);
}
