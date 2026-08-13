import { expect, type APIRequestContext, type Page, type Response, type Route } from "@playwright/test";

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

/** Rewrite /auth/x/login to attach e2e_user / e2e_fail for per-context mock identities. */
export async function attachE2ELoginRoute(
  page: Page,
  opts: { e2eUser?: string; e2eFail?: "token" | "deny" | "expired" }
) {
  await page.route("**/auth/x/login*", async (route: Route) => {
    const url = new URL(route.request().url());
    if (opts.e2eUser) url.searchParams.set("e2e_user", opts.e2eUser);
    if (opts.e2eFail) url.searchParams.set("e2e_fail", opts.e2eFail);
    await route.continue({ url: url.toString() });
  });
}

export type OAuthPopupCapture = {
  callbackStatus: number;
  csp: string;
  html: string;
  completion: { source?: string; status?: string } | null;
};

type OpenerOauthBridge = {
  __chOauthMsgs: Array<{ source?: string; status?: string }>;
  __chOauthOnMessage?: (ev: MessageEvent) => void;
  __chOauthBc?: BroadcastChannel;
};

/** Reset opener OAuth listeners so repeated logins do not accumulate handlers/messages. */
async function installOpenerOauthListeners(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as OpenerOauthBridge;
    if (w.__chOauthOnMessage) {
      window.removeEventListener("message", w.__chOauthOnMessage as EventListener);
    }
    if (w.__chOauthBc) {
      try {
        w.__chOauthBc.close();
      } catch {
        /* already closed */
      }
      w.__chOauthBc = undefined;
    }
    w.__chOauthMsgs = [];
    w.__chOauthOnMessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (data && typeof data === "object") {
        w.__chOauthMsgs.push(data as { source?: string; status?: string });
      }
    };
    window.addEventListener("message", w.__chOauthOnMessage as EventListener);
    try {
      w.__chOauthBc = new BroadcastChannel("consensushealth-oauth");
      w.__chOauthBc.onmessage = (ev) => {
        const data = ev.data;
        if (data && typeof data === "object") {
          w.__chOauthMsgs.push(data as { source?: string; status?: string });
        }
      };
    } catch {
      /* BroadcastChannel unavailable */
    }
  });
}

async function cleanupOpenerOauthListeners(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as OpenerOauthBridge;
    if (w.__chOauthOnMessage) {
      window.removeEventListener("message", w.__chOauthOnMessage as EventListener);
      w.__chOauthOnMessage = undefined;
    }
    if (w.__chOauthBc) {
      try {
        w.__chOauthBc.close();
      } catch {
        /* already closed */
      }
      w.__chOauthBc = undefined;
    }
  }).catch(() => {
    /* page may already be closed in teardown */
  });
}

function isOauthCallbackDocumentResponse(res: Response, openerOrigin: string): boolean {
  try {
    const u = new URL(res.url());
    if (u.origin !== openerOrigin) return false;
    if (u.pathname !== "/auth/x/callback") return false;
    const req = res.request();
    // Popup navigates to the callback document — ignore subresource fetches.
    return req.isNavigationRequest() || req.resourceType() === "document";
  } catch {
    return false;
  }
}

/**
 * Race-safe mock OAuth via real popup login.
 * Captures /auth/x/callback on the BrowserContext (popup navigation) plus parent
 * completion signals. Does not require reading the closed popup DOM.
 */
export async function mockOAuthLogin(
  page: Page,
  opts?: {
    e2eUser?: string;
    path?: string;
    e2eFail?: "token" | "deny" | "expired";
    expectSession?: boolean;
  }
): Promise<OAuthPopupCapture> {
  const path = opts?.path || "/bip/54";
  const expectSession = opts?.expectSession !== false && !opts?.e2eFail;
  if (opts?.e2eUser || opts?.e2eFail) {
    await attachE2ELoginRoute(page, { e2eUser: opts.e2eUser, e2eFail: opts.e2eFail });
  }
  await ackPrivacyDisclosure(page);
  await page.goto(path);
  await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

  const openerOrigin = new URL(page.url()).origin;

  // Parent + context listeners BEFORE click — popup may close before DOM is readable.
  await installOpenerOauthListeners(page);

  const callbackPromise = page.context().waitForEvent("response", {
    predicate: (res) => isOauthCallbackDocumentResponse(res, openerOrigin),
    timeout: 30_000,
  });
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });

  await page.getByRole("button", { name: /Login with/i }).click();
  const [popup, callbackRes] = await Promise.all([popupPromise, callbackPromise]);

  const csp = callbackRes.headers()["content-security-policy"] || "";
  const html = await callbackRes.text();
  const callbackStatus = callbackRes.status();

  expect(csp, "Helmet CSP on OAuth callback").toMatch(/script-src[^;]*'self'/i);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/i);
  expect(html).toContain("/auth/popup-complete.js");
  expect(html).toMatch(/id="ch-auth-payload"/);
  expect(html).toMatch(/type="application\/json"/);
  expect(html).not.toMatch(
    /<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/json["'])[^>]*>[\s\S]*?<\/script>/i
  );

  // Allow natural auto-close; do not keep the popup open or sleep.
  if (!popup.isClosed()) {
    await popup.waitForEvent("close", { timeout: 15_000 });
  }

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const w = window as unknown as OpenerOauthBridge;
          return (w.__chOauthMsgs || []).length;
        }),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0);

  const completion = await page.evaluate(() => {
    const w = window as unknown as OpenerOauthBridge;
    return (w.__chOauthMsgs || [])[0] || null;
  });

  try {
    if (expectSession) {
      expect(callbackStatus).toBe(200);
      expect(html).toMatch(/Signed in/i);
      expect(completion?.status).toBe("success");
      await expect
        .poll(
          async () => {
            const me = await fetchMe(page);
            return Boolean(
              me.body && typeof me.body === "object" && (me.body as { x_user_id?: string }).x_user_id
            );
          },
          { timeout: 30_000 }
        )
        .toBeTruthy();
    } else {
      expect(callbackStatus).toBe(200);
      expect(html).toMatch(/Sign-in failed/i);
      expect(completion?.status).toBe("error");
      const me = await fetchMe(page);
      expect(me.body).toBeNull();
    }
  } finally {
    await cleanupOpenerOauthListeners(page);
  }

  return { callbackStatus, csp, html, completion };
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

export async function fetchStanceHistoryItems(page: Page, proposal: string, handle: string) {
  return page.evaluate(
    async ({ proposal: p, handle: h }) => {
      const r = await fetch(
        `/api/stance-history?proposal=${encodeURIComponent(p)}&handle=${encodeURIComponent(h)}`,
        { credentials: "include" }
      );
      const body = await r.json();
      const items = Array.isArray(body?.items)
        ? body.items
        : Array.isArray(body?.history)
          ? body.history
          : Array.isArray(body)
            ? body
            : [];
      return { status: r.status, items };
    },
    { proposal, handle }
  );
}
