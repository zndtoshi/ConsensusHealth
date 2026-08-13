import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import {
  assertClientIpConfig,
  clientIpRateLimitKey,
  createOriginLockMiddleware,
  getValidatedClientIp,
  parseFirstXffForTests,
  resolveClientIpConfig,
  resolveTrustProxyMode,
  type ClientIpConfig,
} from "./clientIp.js";

function fakeReq(partial: {
  ip?: string;
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
  path?: string;
  url?: string;
}): Request {
  return {
    ip: partial.ip,
    path: partial.path ?? "/",
    url: partial.url ?? "/",
    headers: partial.headers ?? {},
    socket: { remoteAddress: partial.remoteAddress ?? "203.0.113.9" },
  } as unknown as Request;
}

const SECRET = "a".repeat(32);

test("resolveTrustProxyMode defaults to render_direct", () => {
  assert.equal(resolveTrustProxyMode({}), "render_direct");
  assert.equal(resolveTrustProxyMode({ TRUST_PROXY_MODE: "cloudflare" }), "cloudflare_origin_lock");
});

test("production cloudflare_origin_lock without secret is fatal", () => {
  const { fatal } = resolveClientIpConfig(
    { TRUST_PROXY_MODE: "cloudflare_origin_lock" },
    { isProd: true }
  );
  assert.ok(fatal.some((m) => /CF_ORIGIN_SECRET/i.test(m)));
});

test("assertClientIpConfig throws on fatal when throwOnFatal", () => {
  assert.throws(
    () =>
      assertClientIpConfig(
        { TRUST_PROXY_MODE: "cloudflare_origin_lock", CF_ORIGIN_SECRET: "short" },
        { isProd: true, throwOnFatal: true }
      ),
    /CF_ORIGIN_SECRET/
  );
});

test("render_direct ignores spoofed CF-Connecting-IP and XFF", () => {
  const config: ClientIpConfig = {
    mode: "render_direct",
    trustProxyHops: 1,
    originSecret: null,
    originSecretHeader: "x-origin-verify",
  };
  const req = fakeReq({
    ip: "198.51.100.10",
    remoteAddress: "198.51.100.10",
    headers: {
      "cf-connecting-ip": "203.0.113.1",
      "x-forwarded-for": "203.0.113.2, 198.51.100.10",
    },
  });
  assert.equal(getValidatedClientIp(req, config), "198.51.100.10");
});

test("cloudflare_origin_lock accepts CF-Connecting-IP only with correct secret", () => {
  const config: ClientIpConfig = {
    mode: "cloudflare_origin_lock",
    trustProxyHops: 1,
    originSecret: SECRET,
    originSecretHeader: "x-origin-verify",
  };
  const ok = fakeReq({
    ip: "104.16.0.1",
    remoteAddress: "104.16.0.1",
    headers: {
      "x-origin-verify": SECRET,
      "cf-connecting-ip": "2001:db8::1",
    },
  });
  assert.equal(getValidatedClientIp(ok, config), "2001:db8::1");

  const spoof = fakeReq({
    ip: "203.0.113.50",
    remoteAddress: "203.0.113.50",
    headers: {
      "x-origin-verify": "wrong-secret-xxxxxxxxxxxxxxxxxxxx",
      "cf-connecting-ip": "198.51.100.99",
      "x-forwarded-for": "198.51.100.99",
    },
  });
  assert.equal(getValidatedClientIp(spoof, config), "203.0.113.50");

  const missing = fakeReq({
    remoteAddress: "203.0.113.51",
    headers: { "cf-connecting-ip": "198.51.100.88" },
  });
  assert.equal(getValidatedClientIp(missing, config), "203.0.113.51");
});

test("malformed CF-Connecting-IP falls back when secret present", () => {
  const config: ClientIpConfig = {
    mode: "cloudflare_origin_lock",
    trustProxyHops: 1,
    originSecret: SECRET,
    originSecretHeader: "x-origin-verify",
  };
  const req = fakeReq({
    ip: "104.16.0.2",
    remoteAddress: "104.16.0.2",
    headers: {
      "x-origin-verify": SECRET,
      "cf-connecting-ip": "not-an-ip",
    },
  });
  assert.equal(getValidatedClientIp(req, config), "104.16.0.2");
});

test("multiple visitors behind different CF edges get distinct rate keys", () => {
  const config: ClientIpConfig = {
    mode: "cloudflare_origin_lock",
    trustProxyHops: 1,
    originSecret: SECRET,
    originSecretHeader: "x-origin-verify",
  };
  const a = clientIpRateLimitKey(
    fakeReq({
      headers: { "x-origin-verify": SECRET, "cf-connecting-ip": "203.0.113.10" },
    }),
    config
  );
  const b = clientIpRateLimitKey(
    fakeReq({
      headers: { "x-origin-verify": SECRET, "cf-connecting-ip": "203.0.113.11" },
    }),
    config
  );
  assert.notEqual(a, b);
});

test("origin lock middleware 403 without secret; exempts health/ready", () => {
  const config: ClientIpConfig = {
    mode: "cloudflare_origin_lock",
    trustProxyHops: 1,
    originSecret: SECRET,
    originSecretHeader: "x-origin-verify",
  };
  const mw = createOriginLockMiddleware(config);

  const blocked = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(_payload: unknown) {
      return this;
    },
  };
  let nextBlocked = false;
  mw(fakeReq({ path: "/api/community" }), blocked as never, () => {
    nextBlocked = true;
  });
  assert.equal(nextBlocked, false);
  assert.equal(blocked.statusCode, 403);

  let healthNext = false;
  mw(fakeReq({ path: "/api/health" }), {} as never, () => {
    healthNext = true;
  });
  assert.equal(healthNext, true);

  let readyNext = false;
  mw(fakeReq({ path: "/api/ready" }), {} as never, () => {
    readyNext = true;
  });
  assert.equal(readyNext, true);

  let okNext = false;
  mw(fakeReq({ path: "/api/me", headers: { "x-origin-verify": SECRET } }), {} as never, () => {
    okNext = true;
  });
  assert.equal(okNext, true);
});

test("parseFirstXffForTests takes first hop only", () => {
  assert.equal(parseFirstXffForTests("203.0.113.1, 198.51.100.1"), "203.0.113.1");
});
