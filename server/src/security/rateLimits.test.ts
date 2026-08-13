import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import {
  RATE_LIMITED_BODY,
  buildAccountRateLimitKey,
  buildAuthWriteRateLimitKey,
  buildIpRateLimitKey,
  createAuthRateLimiter,
  createDualWriteRateLimiters,
  createGeneralApiRateLimiter,
  createStanceWriteRateLimiters,
} from "./rateLimits.js";

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test("buildIpRateLimitKey and buildAccountRateLimitKey are independent", () => {
  const req = { ip: "203.0.113.10" } as Request;
  assert.match(buildIpRateLimitKey(req), /203\.0\.113\.10/);
  assert.equal(buildAccountRateLimitKey(req, () => "42"), "uid:42");
  assert.equal(buildAccountRateLimitKey(req, () => null), null);
});

test("buildAuthWriteRateLimitKey prefers account key then IP (legacy helper)", () => {
  const req = { ip: "203.0.113.10" } as Request;
  assert.equal(buildAuthWriteRateLimitKey(req, () => "42"), "uid:42");
  assert.match(buildAuthWriteRateLimitKey(req, () => null), /203\.0\.113\.10/);
});

test("createGeneralApiRateLimiter returns 429 body with Retry-After", async () => {
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api", createGeneralApiRateLimiter({ windowMs: 60_000, max: 2 }));
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
    const r1 = await fetch(`${base}/api/ping`);
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${base}/api/ping`);
    assert.equal(r2.status, 200);
    const r3 = await fetch(`${base}/api/ping`);
    assert.equal(r3.status, 429);
    assert.ok(r3.headers.get("retry-after"));
    const body = (await r3.json()) as typeof RATE_LIMITED_BODY;
    assert.deepEqual(body, RATE_LIMITED_BODY);
  });
});

test("dual stance writers: IP quota survives account rotation", async () => {
  const app = express();
  app.set("trust proxy", 1);
  let currentUser: string | null = "u1";
  const [ipLimiter, accountLimiter] = createDualWriteRateLimiters(
    { windowMs: 60_000, max: 1 },
    { getXUserId: () => currentUser }
  );
  app.post("/api/stance", ipLimiter, accountLimiter, (_req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
    const a1 = await fetch(`${base}/api/stance`, { method: "POST" });
    assert.equal(a1.status, 200);
    // Same IP, new account — IP limiter still exhausted.
    currentUser = "u2";
    const b1 = await fetch(`${base}/api/stance`, { method: "POST" });
    assert.equal(b1.status, 429);
  });
});

test("dual stance writers: account quota survives IP rotation via X-Forwarded-For", async () => {
  const app = express();
  app.set("trust proxy", 1);
  const [ipLimiter, accountLimiter] = createStanceWriteRateLimiters({
    windowMs: 60_000,
    max: 1,
    getXUserId: () => "same-user",
  });
  app.post("/api/stance", ipLimiter, accountLimiter, (_req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
    const a1 = await fetch(`${base}/api/stance`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    assert.equal(a1.status, 200);
    const a2 = await fetch(`${base}/api/stance`, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    assert.equal(a2.status, 429);
  });
});

test("createAuthRateLimiter is an independent limiter factory", () => {
  assert.equal(typeof createAuthRateLimiter({ max: 5, windowMs: 1000 }), "function");
});
