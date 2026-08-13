/**
 * Eager OAuth callback capture for Playwright E2E.
 *
 * The popup may auto-close immediately after `/auth/x/callback` loads. Storing a
 * Response and calling `.text()` later races with target destruction. Starting
 * `response.body()` synchronously inside the context `response` handler keeps
 * the body read alive independently of the popup Page lifetime.
 */

export type BufferedOauthCallback = {
  callbackStatus: number;
  csp: string;
  html: string;
};

/** Minimal Response shape used by the matcher/controller (Playwright-compatible). */
export type OauthCallbackResponseLike = {
  url: () => string;
  status: () => number;
  headers: () => Record<string, string>;
  body: () => Promise<Uint8Array | Buffer>;
  request: () => {
    isNavigationRequest: () => boolean;
    resourceType: () => string;
  };
};

export type OauthCallbackCaptureController = {
  onResponse: (response: OauthCallbackResponseLike) => void;
  capturePromise: Promise<BufferedOauthCallback>;
  detach: () => void;
  /** True after the first matching response was accepted (body read started). */
  readonly accepted: boolean;
  /** True after capturePromise settled (fulfill or reject). */
  readonly settled: boolean;
};

export const OAUTH_CALLBACK_CAPTURE_TIMEOUT_MS = 30_000;

export function isOauthCallbackDocumentResponse(
  response: OauthCallbackResponseLike,
  openerOrigin: string
): boolean {
  try {
    const u = new URL(response.url());
    if (u.origin !== openerOrigin) return false;
    if (u.pathname !== "/auth/x/callback") return false;
    const req = response.request();
    return req.isNavigationRequest() || req.resourceType() === "document";
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Uint8Array | Buffer): string {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(bytes)) {
    return bytes.toString("utf8");
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Single-use capture controller. Call `onResponse` from a BrowserContext
 * `response` listener. The first matching document starts `body()` immediately
 * (synchronously in `onResponse`) and resolves after that read completes.
 */
export function createOauthCallbackCaptureController(opts: {
  openerOrigin: string;
  timeoutMs?: number;
}): OauthCallbackCaptureController {
  const timeoutMs = opts.timeoutMs ?? OAUTH_CALLBACK_CAPTURE_TIMEOUT_MS;
  let accepted = false;
  let settled = false;
  let settle!: (value: BufferedOauthCallback) => void;
  let fail!: (err: Error) => void;

  const capturePromise = new Promise<BufferedOauthCallback>((resolve, reject) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
  });

  const timer = setTimeout(() => {
    fail(new Error(`OAuth callback capture timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onResponse = (response: OauthCallbackResponseLike) => {
    if (accepted || settled) return;
    if (!isOauthCallbackDocumentResponse(response, opts.openerOrigin)) return;

    accepted = true;
    const callbackStatus = response.status();
    const headers = response.headers();
    const csp = headers["content-security-policy"] || headers["Content-Security-Policy"] || "";

    // Eager body consumption — must start before any await yields to the event loop.
    const bodyPromise = response.body();

    void bodyPromise
      .then((bytes) => {
        settle({
          callbackStatus,
          csp,
          html: decodeUtf8(bytes),
        });
      })
      .catch((err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
  };

  const detach = () => {
    clearTimeout(timer);
    if (!settled) {
      fail(new Error("OAuth callback capture detached before completion"));
    }
  };

  return {
    onResponse,
    capturePromise,
    detach,
    get accepted() {
      return accepted;
    },
    get settled() {
      return settled;
    },
  };
}
