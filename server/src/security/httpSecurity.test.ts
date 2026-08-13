import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PERMISSIONS_POLICY,
  createHelmetMiddleware,
  createPermissionsPolicyMiddleware,
} from "./httpSecurity.js";

test("createHelmetMiddleware returns a function for prod and non-prod", () => {
  assert.equal(typeof createHelmetMiddleware({ isProd: true }), "function");
  assert.equal(typeof createHelmetMiddleware({ isProd: false }), "function");
});

test("Permissions-Policy disables sensitive features", () => {
  assert.match(PERMISSIONS_POLICY, /camera=\(\)/);
  assert.match(PERMISSIONS_POLICY, /geolocation=\(\)/);
  assert.equal(typeof createPermissionsPolicyMiddleware(), "function");
});

test("helmet middleware sets security headers on a mock response", async () => {
  const mw = createHelmetMiddleware({ isProd: true });
  const headers = new Map<string, string>();
  const req = {
    method: "GET",
    url: "/",
    headers: {},
  } as unknown as import("express").Request;
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
  } as unknown as import("express").Response;

  await new Promise<void>((resolve, reject) => {
    mw(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });

  const csp = headers.get("content-security-policy") || "";
  assert.match(csp, /script-src[^;]*'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /style-src[^;]*'unsafe-inline'/);
  assert.match(csp, /img-src[^;]*pbs\.twimg\.com/);
  assert.match(csp, /frame-ancestors[^;]*'none'/);

  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin-allow-popups");
  assert.ok(headers.get("strict-transport-security"));
  assert.equal(headers.get("referrer-policy"), "strict-origin-when-cross-origin");
});

test("helmet middleware omits HSTS outside production", async () => {
  const mw = createHelmetMiddleware({ isProd: false });
  const headers = new Map<string, string>();
  const req = { method: "GET", url: "/", headers: {} } as unknown as import("express").Request;
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value));
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase());
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
  } as unknown as import("express").Response;

  await new Promise<void>((resolve, reject) => {
    mw(req, res, (err?: unknown) => (err ? reject(err) : resolve()));
  });

  assert.equal(headers.get("strict-transport-security"), undefined);
});
