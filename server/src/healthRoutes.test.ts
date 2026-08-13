import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHealthRouter, HEALTH_SERVICE_NAME } from "./healthRoutes.js";

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test("GET /api/health is cheap liveness without secrets", async () => {
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      pool: { query: async () => ({ rows: [{ ok: 1 }] }) } as never,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    })
  );

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.service, HEALTH_SERVICE_NAME);
    assert.equal(body.time, "2026-08-13T00:00:00.000Z");
    assert.equal(body.DATABASE_URL, undefined);
    assert.equal(body.stack, undefined);
  });
});

test("GET /api/ready returns 200 when SELECT 1 succeeds", async () => {
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      pool: {
        query: async (sql: string) => {
          assert.match(sql, /SELECT 1/i);
          return { rows: [{ ok: 1 }] };
        },
      } as never,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    })
  );

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/ready`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
  });
});

test("GET /api/ready returns 503 without stack when DB fails", async () => {
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      pool: {
        query: async () => {
          throw new Error("ECONNREFUSED secret-connection-string");
        },
      } as never,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    })
  );

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/ready`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error, "not_ready");
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /ECONNREFUSED|secret-connection|stack/i);
  });
});

test("GET /api/ready times out to 503", async () => {
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      readyTimeoutMs: 30,
      pool: {
        query: async () => new Promise(() => {}),
      } as never,
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    })
  );

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/ready`);
    assert.equal(res.status, 503);
  });
});
