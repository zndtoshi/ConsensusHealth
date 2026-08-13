import test from "node:test";
import assert from "node:assert/strict";
import {
  createOauthCallbackCaptureController,
  isOauthCallbackDocumentResponse,
  type OauthCallbackResponseLike,
} from "./oauthCallbackCapture";

function fakeResponse(opts: {
  url: string;
  status?: number;
  headers?: Record<string, string>;
  navigation?: boolean;
  resourceType?: string;
  body?: Uint8Array | Buffer | (() => Promise<Uint8Array | Buffer>);
  onBodyStart?: () => void;
}): OauthCallbackResponseLike {
  return {
    url: () => opts.url,
    status: () => opts.status ?? 200,
    headers: () => opts.headers ?? { "content-security-policy": "script-src 'self'" },
    body: () => {
      opts.onBodyStart?.();
      if (typeof opts.body === "function") return opts.body();
      return Promise.resolve(opts.body ?? Buffer.from("<html>ok</html>", "utf8"));
    },
    request: () => ({
      isNavigationRequest: () => opts.navigation ?? true,
      resourceType: () => opts.resourceType ?? "document",
    }),
  };
}

const ORIGIN = "http://127.0.0.1:8787";

test("matches exact opener origin + /auth/x/callback document/navigation", () => {
  assert.equal(
    isOauthCallbackDocumentResponse(
      fakeResponse({ url: `${ORIGIN}/auth/x/callback?code=1&state=2` }),
      ORIGIN
    ),
    true
  );
  assert.equal(
    isOauthCallbackDocumentResponse(
      fakeResponse({
        url: `${ORIGIN}/auth/x/callback?code=1`,
        navigation: false,
        resourceType: "document",
      }),
      ORIGIN
    ),
    true
  );
});

test("rejects wrong origin, path, or subresource", () => {
  assert.equal(
    isOauthCallbackDocumentResponse(
      fakeResponse({ url: "http://evil.example/auth/x/callback" }),
      ORIGIN
    ),
    false
  );
  assert.equal(
    isOauthCallbackDocumentResponse(fakeResponse({ url: `${ORIGIN}/auth/x/login` }), ORIGIN),
    false
  );
  assert.equal(
    isOauthCallbackDocumentResponse(
      fakeResponse({
        url: `${ORIGIN}/auth/x/callback`,
        navigation: false,
        resourceType: "script",
      }),
      ORIGIN
    ),
    false
  );
});

test("eagerly starts body() synchronously on first match", async () => {
  let bodyStarted = false;
  let resolveBody!: (v: Buffer) => void;
  const bodyPromise = new Promise<Buffer>((resolve) => {
    resolveBody = resolve;
  });

  const ctrl = createOauthCallbackCaptureController({ openerOrigin: ORIGIN, timeoutMs: 5_000 });
  ctrl.onResponse(
    fakeResponse({
      url: `${ORIGIN}/auth/x/callback?code=a`,
      onBodyStart: () => {
        bodyStarted = true;
      },
      body: () => bodyPromise,
    })
  );

  assert.equal(bodyStarted, true);
  assert.equal(ctrl.accepted, true);
  assert.equal(ctrl.settled, false);

  resolveBody(Buffer.from("<html>Signed in</html>", "utf8"));
  const capture = await ctrl.capturePromise;
  assert.equal(capture.callbackStatus, 200);
  assert.match(capture.html, /Signed in/);
  assert.match(capture.csp, /script-src/);
  assert.equal(ctrl.settled, true);
  ctrl.detach();
});

test("single-use: ignores later matching responses", async () => {
  let bodyCalls = 0;
  const ctrl = createOauthCallbackCaptureController({ openerOrigin: ORIGIN, timeoutMs: 5_000 });

  ctrl.onResponse(
    fakeResponse({
      url: `${ORIGIN}/auth/x/callback?first=1`,
      body: Buffer.from("first", "utf8"),
      onBodyStart: () => {
        bodyCalls += 1;
      },
    })
  );
  ctrl.onResponse(
    fakeResponse({
      url: `${ORIGIN}/auth/x/callback?second=1`,
      body: Buffer.from("second", "utf8"),
      onBodyStart: () => {
        bodyCalls += 1;
      },
    })
  );

  const capture = await ctrl.capturePromise;
  assert.equal(bodyCalls, 1);
  assert.equal(capture.html, "first");
  ctrl.detach();
});

test("propagates body read failures", async () => {
  const ctrl = createOauthCallbackCaptureController({ openerOrigin: ORIGIN, timeoutMs: 5_000 });
  ctrl.onResponse(
    fakeResponse({
      url: `${ORIGIN}/auth/x/callback`,
      body: () => Promise.reject(new Error("body gone")),
    })
  );
  await assert.rejects(() => ctrl.capturePromise, /body gone/);
  assert.equal(ctrl.settled, true);
  ctrl.detach();
});

test("timeout rejects when no matching callback arrives", async () => {
  const ctrl = createOauthCallbackCaptureController({ openerOrigin: ORIGIN, timeoutMs: 30 });
  ctrl.onResponse(fakeResponse({ url: `${ORIGIN}/api/me`, navigation: false, resourceType: "fetch" }));
  await assert.rejects(() => ctrl.capturePromise, /timed out after 30ms/);
  assert.equal(ctrl.accepted, false);
  assert.equal(ctrl.settled, true);
});

test("detach rejects pending capture and stops accepting responses", async () => {
  const ctrl = createOauthCallbackCaptureController({ openerOrigin: ORIGIN, timeoutMs: 5_000 });
  const pending = ctrl.capturePromise;
  ctrl.detach();
  await assert.rejects(() => pending, /detached before completion/);
  assert.equal(ctrl.settled, true);

  let bodyCalls = 0;
  ctrl.onResponse(
    fakeResponse({
      url: `${ORIGIN}/auth/x/callback`,
      onBodyStart: () => {
        bodyCalls += 1;
      },
    })
  );
  assert.equal(bodyCalls, 0);
  assert.equal(ctrl.accepted, false);
});
