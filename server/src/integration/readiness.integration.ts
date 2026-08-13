/**
 * Real Postgres readiness checks via createHealthRouter (no full index.ts import).
 * Requires TEST_DATABASE_URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { createHealthRouter, HEALTH_SERVICE_NAME } from "../healthRoutes.js";
import {
  assertSafeTestDatabaseUrl,
  createTestPool,
  getRequiredTestDatabaseUrl,
} from "./helpers.js";

const TEST_DATABASE_URL = getRequiredTestDatabaseUrl();
assertSafeTestDatabaseUrl(TEST_DATABASE_URL);

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

test("integration: /api/ready is 200 when Postgres is available, 503 after pool closed", async () => {
  const pool = createTestPool({ max: 2 });
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      pool,
      readyTimeoutMs: 2000,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    })
  );

  try {
    await withServer(app, async (base) => {
      const live = await fetch(`${base}/api/ready`);
      assert.equal(live.status, 200);
      const liveBody = (await live.json()) as Record<string, unknown>;
      assert.equal(liveBody.ok, true);
      assert.equal(liveBody.service, HEALTH_SERVICE_NAME);
      assert.equal(liveBody.DATABASE_URL, undefined);
      assert.equal(liveBody.stack, undefined);

      const health = await fetch(`${base}/api/health`);
      assert.equal(health.status, 200);

      await pool.end();

      const down = await fetch(`${base}/api/ready`);
      assert.equal(down.status, 503);
      const downBody = (await down.json()) as Record<string, unknown>;
      assert.equal(downBody.ok, false);
      assert.equal(downBody.error, "not_ready");
      const raw = JSON.stringify(downBody);
      assert.doesNotMatch(raw, /DATABASE_URL|connectionString|password|stack/i);
    });
  } finally {
    try {
      await pool.end();
    } catch {
      // already ended
    }
  }
});

test("integration: /api/ready is 503 for unreachable Postgres", async () => {
  // Bound to an unused local port — not a shared/prod host.
  const dead = new Pool({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:1/postgres",
    max: 1,
    connectionTimeoutMillis: 300,
  });
  const app = express();
  app.use(
    "/api",
    createHealthRouter({
      pool: dead,
      readyTimeoutMs: 500,
      now: () => new Date("2026-08-13T12:00:00.000Z"),
    })
  );

  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.ok, false);
      assert.equal(body.error, "not_ready");
    });
  } finally {
    await dead.end().catch(() => undefined);
  }
});
