import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";
import type { BufferedOauthCallback } from "../src/utils/oauthCallbackCapture";
import {
  isStanceOverlayPointerInterceptError,
  resolveStanceDialogOpenPlan,
} from "../src/utils/stanceChoiceUi";
import { buildE2EMockHandle, resolveE2EMockIdentity } from "../server/src/e2eMockIdentity";

export type { BufferedOauthCallback };
export { buildE2EMockHandle, resolveE2EMockIdentity };

/** Expected mock handle for an e2e_user key (same builder as the server). */
export function e2eHandleForUser(e2eUserKey: string): string {
  return buildE2EMockHandle(e2eUserKey);
}

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

export type DetachRoute = () => Promise<void>;

const E2E_LOGIN_ROUTE_PATTERN = "**/auth/x/login*";

/**
 * Rewrite /auth/x/login at BrowserContext scope so the popup's initial
 * navigation is intercepted. Returns an explicit detach for this handler only.
 */
export async function attachE2ELoginRoute(
  page: Page,
  opts: { e2eUser?: string; e2eFail?: "token" | "deny" | "expired" }
): Promise<DetachRoute> {
  const context = page.context();
  const handler = async (route: Route) => {
    const req = route.request();
    let url: URL;
    try {
      url = new URL(req.url());
    } catch {
      await route.continue();
      return;
    }
    if (url.pathname !== "/auth/x/login") {
      await route.continue();
      return;
    }
    if (!req.isNavigationRequest() && req.resourceType() !== "document") {
      await route.continue();
      return;
    }
    if (opts.e2eUser) url.searchParams.set("e2e_user", opts.e2eUser);
    if (opts.e2eFail) url.searchParams.set("e2e_fail", opts.e2eFail);
    await route.continue({ url: url.toString() });
  };
  await context.route(E2E_LOGIN_ROUTE_PATTERN, handler);
  return async () => {
    await context.unroute(E2E_LOGIN_ROUTE_PATTERN, handler);
  };
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
  await page
    .evaluate(() => {
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
    })
    .catch(() => {
      /* page may already be closed in teardown */
    });
}

/**
 * Register a single-use BrowserContext `response` listener that starts
 * `response.body()` immediately on the matching callback document — before the
 * popup can auto-close and invalidate a later `.text()` call. Does not alter
 * the real callback request/response.
 */
export async function attachOauthCallbackCapture(
  page: Page,
  openerOrigin: string
): Promise<{ capturePromise: Promise<BufferedOauthCallback>; detach: DetachRoute }> {
  const context = page.context();
  let settled = false;
  let resolveCapture!: (value: BufferedOauthCallback) => void;
  let rejectCapture!: (error: Error) => void;
  const capturePromise = new Promise<BufferedOauthCallback>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCapture(new Error("OAuth callback capture timed out after 30000ms"));
  }, 30_000);

  const callbackPattern = "**/auth/x/callback*";
  const handler = async (route: Route) => {
    if (settled) {
      await route.continue();
      return;
    }
    try {
      const url = new URL(route.request().url());
      if (url.origin !== openerOrigin || url.pathname !== "/auth/x/callback") {
        await route.continue();
        return;
      }
      // Buffer before fulfilling the popup navigation. The popup cannot close
      // until it receives this exact response, eliminating the target-close race.
      const response = await route.fetch();
      const bytes = await response.body();
      const headers = response.headers();
      await route.fulfill({ response, body: bytes });
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolveCapture({
          callbackStatus: response.status(),
          csp: headers["content-security-policy"] || "",
          html: bytes.toString("utf8"),
        });
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectCapture(error instanceof Error ? error : new Error(String(error)));
      }
      await route.abort().catch(() => undefined);
    }
  };

  await context.route(callbackPattern, handler);

  return {
    capturePromise,
    detach: async () => {
      clearTimeout(timer);
      await context.unroute(callbackPattern, handler);
      if (!settled) {
        settled = true;
        rejectCapture(new Error("OAuth callback capture detached before completion"));
      }
    },
  };
}

/**
 * Race-safe mock OAuth via real popup login.
 * Eagerly buffers /auth/x/callback via a BrowserContext response listener
 * (independent of popup lifetime) plus parent completion signals.
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
  let detachLoginRoute: DetachRoute | null = null;
  let detachCallbackCapture: DetachRoute | null = null;
  let listenersInstalled = false;

  try {
    if (opts?.e2eUser || opts?.e2eFail) {
      detachLoginRoute = await attachE2ELoginRoute(page, {
        e2eUser: opts.e2eUser,
        e2eFail: opts.e2eFail,
      });
    }
    await ackPrivacyDisclosure(page);
    await page.goto(path);
    await expect(page.getByText("Consensus Health").first()).toBeVisible({ timeout: 30_000 });

    const openerOrigin = new URL(page.url()).origin;

    // Parent + context listeners BEFORE click — popup may close before DOM is readable.
    await installOpenerOauthListeners(page);
    listenersInstalled = true;

    const callbackCapture = await attachOauthCallbackCapture(page, openerOrigin);
    detachCallbackCapture = callbackCapture.detach;

    const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
    await page.getByRole("button", { name: /Login with/i }).click();
    const [popup, capture] = await Promise.all([popupPromise, callbackCapture.capturePromise]);

    const { callbackStatus, csp, html } = capture;

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

    return { callbackStatus, csp, html, completion };
  } finally {
    if (listenersInstalled) {
      await cleanupOpenerOauthListeners(page);
    }
    if (detachCallbackCapture) {
      await detachCallbackCapture();
    }
    if (detachLoginRoute) {
      await detachLoginRoute();
    }
  }
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

/** Ensure the stance choice dialog is open without clicking through its overlay. */
export async function ensureStanceChoiceDialogOpen(page: Page) {
  const dialog = stanceChoiceDialog(page);
  const overlay = page.locator(".stanceChoiceOverlay");

  const overlayPresent = (await overlay.count().catch(() => 0)) > 0;
  const dialogPresent =
    (await dialog.count().catch(() => 0)) > 0 ||
    (await dialog.isVisible().catch(() => false));

  if (resolveStanceDialogOpenPlan({ overlayPresent, dialogPresent }) === "wait-for-dialog") {
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    return dialog;
  }

  const openBtn = page
    .getByRole("button", { name: /Choose position|Neutral|Against|Approve|Change your position/i })
    .first();
  try {
    await openBtn.click({ timeout: 3_000 });
  } catch (err) {
    const overlayNow = (await overlay.count().catch(() => 0)) > 0;
    const dialogNow =
      (await dialog.isVisible().catch(() => false)) || (await dialog.count().catch(() => 0)) > 0;
    if (overlayNow || dialogNow || isStanceOverlayPointerInterceptError(err)) {
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      return dialog;
    }
    throw err;
  }

  await expect(dialog).toBeVisible({ timeout: 15_000 });
  return dialog;
}

/** Open stance card if needed, pick stance, Save (first-time or change). */
export async function saveStanceViaUi(page: Page, stance: StanceUiLabel) {
  const dialog = await ensureStanceChoiceDialogOpen(page);
  await dismissDisclosureIfPresent(page);
  await dialog.getByRole("button", { name: stance, exact: true }).click();

  const openerOrigin = new URL(page.url()).origin;
  const stanceResponsePromise = page.waitForResponse(
    (res) => {
      try {
        const u = new URL(res.url());
        return (
          u.origin === openerOrigin &&
          u.pathname === "/api/stance" &&
          res.request().method() === "POST"
        );
      } catch {
        return false;
      }
    },
    { timeout: 30_000 }
  );

  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const stanceRes = await stanceResponsePromise;
  const status = stanceRes.status();
  let body: unknown = null;
  const rawText = await stanceRes.text();
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText;
  }
  expect(
    status,
    `POST /api/stance expected success, got ${status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`
  ).toBe(200);
  // Handler returns the persisted identity/stance row; reject rate-limit / error payloads.
  expect(body, "POST /api/stance success body").toEqual(
    expect.objectContaining({
      x_user_id: expect.any(String),
      handle: expect.any(String),
    })
  );
  expect(body, "POST /api/stance must not be an error payload").not.toMatchObject({
    error: expect.anything(),
  });

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
