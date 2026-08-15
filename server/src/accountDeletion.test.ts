import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACCOUNT_DELETION_SQL_TABLES,
  createAccountDeletionHandler,
  deleteAuthenticatedAccount,
  normalizeDeletionHandle,
  resolveSafeAvatarFilesystemPath,
} from "./accountDeletion.js";

function makeFakePool(opts?: {
  user?: { x_user_id: string; handle: string; avatar_path: string | null } | null;
}) {
  const user =
    opts?.user === undefined
      ? { x_user_id: "42", handle: "alice", avatar_path: "/avatars/42.jpg" }
      : opts.user;
  const deleted: string[] = [];
  const upserted: string[] = [];
  const updated: string[] = [];
  let inTx = false;
  let committed = false;
  let rolledBack = false;

  const client = {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "begin") {
        inTx = true;
        return { rows: [], rowCount: 0 };
      }
      if (text === "commit") {
        inTx = false;
        committed = true;
        return { rows: [], rowCount: 0 };
      }
      if (text === "rollback") {
        inTx = false;
        rolledBack = true;
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("insert into privacy_suppressions")) {
        upserted.push("privacy_suppressions");
        return {
          rows: [
            {
              x_user_id: params[0],
              handle_normalized: params[1],
              created_at: new Date().toISOString(),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.startsWith("select x_user_id, handle, avatar_path from community_users")) {
        if (!user) return { rows: [], rowCount: 0 };
        return { rows: [user], rowCount: 1 };
      }
      if (text.startsWith("update name_the_fork_candidates")) {
        updated.push("name_the_fork_candidates");
        return { rows: [], rowCount: 1, params };
      }
      if (text.startsWith("delete from")) {
        const table = text.match(/delete from (\w+)/)?.[1] ?? "unknown";
        deleted.push(table);
        return { rows: [], rowCount: 1, params };
      }
      throw new Error(`unexpected: ${sql}`);
    },
    release() {},
  };

  const pool = {
    deleted,
    upserted,
    updated,
    get committed() {
      return committed;
    },
    get rolledBack() {
      return rolledBack;
    },
    get inTx() {
      return inTx;
    },
    async connect() {
      return client;
    },
    async query(sql: string, params?: unknown[]) {
      return client.query(sql, params);
    },
  };

  return pool;
}

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

test("normalizeDeletionHandle strips @ and lowercases", () => {
  assert.equal(normalizeDeletionHandle("@Alice"), "alice");
  assert.equal(normalizeDeletionHandle("  BOB  "), "bob");
});

test("resolveSafeAvatarFilesystemPath rejects path traversal", () => {
  const root = "/data/avatars";
  assert.equal(resolveSafeAvatarFilesystemPath(root, "/avatars/../../etc/passwd"), null);
  const ok = resolveSafeAvatarFilesystemPath(root, "/avatars/42.jpg");
  assert.ok(ok);
  assert.match(ok!.replace(/\\/g, "/"), /\/42\.jpg$/);
});

test("deleteAuthenticatedAccount upserts privacy tombstone and deletes expected tables", async () => {
  const pool = makeFakePool();
  const unlinked: string[] = [];
  const result = await deleteAuthenticatedAccount({
    pool: pool as never,
    sessionUser: { x_user_id: "42", handle: "alice" },
    avatarsDir: "/data/avatars",
    unlink: async (p) => {
      unlinked.push(p);
    },
  });
  assert.equal(result.deleted, true);
  assert.ok(pool.committed);
  assert.ok(pool.upserted.includes("privacy_suppressions"));
  assert.ok(!pool.deleted.includes("privacy_suppressions"));
  for (const table of ACCOUNT_DELETION_SQL_TABLES) {
    if (table === "privacy_suppressions") continue;
    assert.ok(pool.deleted.includes(table), `expected delete of ${table}`);
  }
  assert.ok(pool.updated.includes("name_the_fork_candidates"));
  assert.ok(unlinked.some((p) => p.replace(/\\/g, "/").endsWith("/42.jpg")));
});

test("deleteAuthenticatedAccount keeps tombstone when user already gone", async () => {
  const pool = makeFakePool({ user: null });
  const result = await deleteAuthenticatedAccount({
    pool: pool as never,
    sessionUser: { x_user_id: "42", handle: "alice" },
    avatarsDir: "/data/avatars",
    unlink: async () => {},
  });
  assert.deepEqual(result, {
    deleted: false,
    reason: "not_found",
    x_user_id: "42",
    handle: "alice",
  });
  assert.ok(pool.committed);
  assert.ok(pool.upserted.includes("privacy_suppressions"));
  assert.ok(pool.deleted.includes("sessions"));
  assert.ok(!pool.deleted.includes("privacy_suppressions"));
});

test("POST /api/me/delete requires matching confirm_handle and clears session", async () => {
  const pool = makeFakePool();
  let cleared = false;
  let invalidated = false;
  const app = express();
  app.use(express.json());
  app.post(
    "/api/me/delete",
    createAccountDeletionHandler({
      pool: pool as never,
      getSessionUser: () => ({ x_user_id: "42", handle: "alice" }),
      avatarsDir: "/data/avatars",
      invalidateStatsCache: () => {
        invalidated = true;
      },
      clearSessionCookie: (res) => {
        cleared = true;
        res.clearCookie("consensushealth_session");
      },
      deleteAccount: async () => ({
        deleted: true,
        x_user_id: "42",
        handle: "alice",
        avatar_path: null,
      }),
    })
  );

  await withServer(app, async (base) => {
    const bad = await fetch(`${base}/api/me/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm_handle: "@other" }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${base}/api/me/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm_handle: "@Alice" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, deleted: true, suppressed: true });
    assert.equal(cleared, true);
    assert.equal(invalidated, true);
  });
});

test("POST /api/me/delete returns deleted:false when already gone", async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/api/me/delete",
    createAccountDeletionHandler({
      pool: {} as never,
      getSessionUser: () => ({ x_user_id: "42", handle: "alice" }),
      avatarsDir: "/tmp",
      invalidateStatsCache: () => {},
      clearSessionCookie: (res) => res.clearCookie("consensushealth_session"),
      deleteAccount: async () => ({
        deleted: false,
        reason: "not_found",
        x_user_id: "42",
        handle: "alice",
      }),
    })
  );

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/me/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm_handle: "alice" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, deleted: false, suppressed: true });
  });
});
