import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OAUTH_STATE_SQL,
  OAUTH_STATE_TTL_MS,
  cleanupExpiredOAuthStates,
  consumeOAuthState,
  ensureOAuthStateTable,
  saveOAuthState,
  type OAuthPendingState,
} from "./oauthStateStore.js";

type FakeRow = {
  state: string;
  code_verifier: string;
  mode: string;
  browser_nonce: string;
  created_at: Date;
  expires_at: Date;
};

function makeFakePool(seed: FakeRow[] = []) {
  const rows = new Map(seed.map((r) => [r.state, { ...r }]));
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const pool = {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const text = sql.replace(/\s+/g, " ").trim().toLowerCase();

      if (text.startsWith("create table") || text.startsWith("create index")) {
        return { rows: [], rowCount: 0 };
      }

      if (text.startsWith("insert into oauth_pending_states")) {
        const [state, code_verifier, mode, browser_nonce, created_at, expires_at] = params as [
          string,
          string,
          string,
          string,
          Date,
          Date,
        ];
        const row: FakeRow = {
          state,
          code_verifier,
          mode,
          browser_nonce,
          created_at,
          expires_at,
        };
        rows.set(state, row);
        return { rows: [row], rowCount: 1 };
      }

      if (text.startsWith("delete from oauth_pending_states where state")) {
        const state = String(params[0] ?? "");
        const nonce = String(params[1] ?? "");
        const now = params[2] as Date;
        const row = rows.get(state);
        if (!row) return { rows: [], rowCount: 0 };
        if (row.browser_nonce !== nonce) return { rows: [], rowCount: 0 };
        if (!(row.expires_at.getTime() > now.getTime())) return { rows: [], rowCount: 0 };
        rows.delete(state);
        return { rows: [row], rowCount: 1 };
      }

      if (text.startsWith("delete from oauth_pending_states where expires_at")) {
        const now = params[0] as Date;
        let count = 0;
        for (const [k, r] of [...rows.entries()]) {
          if (r.expires_at.getTime() <= now.getTime()) {
            rows.delete(k);
            count++;
          }
        }
        return { rows: [], rowCount: count };
      }

      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  return { pool, rows };
}

test("OAUTH_STATE_TTL_MS is ~10 minutes", () => {
  assert.equal(OAUTH_STATE_TTL_MS, 10 * 60 * 1000);
});

test("ensureOAuthStateTable issues create SQL", async () => {
  const { pool } = makeFakePool();
  await ensureOAuthStateTable(pool as never);
  assert.ok(pool.queries.some((q) => q.sql.includes(OAUTH_STATE_SQL.createTable)));
});

test("consume SQL is browser-bound and unexpired", () => {
  assert.match(OAUTH_STATE_SQL.consumeBrowserBound, /browser_nonce/);
  assert.match(OAUTH_STATE_SQL.consumeUnexpired, /expires_at/);
});

test("save + consume is one-time (atomic delete-returning)", async () => {
  const { pool } = makeFakePool();
  const now = new Date("2026-01-01T00:00:00.000Z");
  await saveOAuthState(pool as never, {
    state: "s1",
    code_verifier: "verifier",
    mode: "popup",
    browser_nonce: "nonce-1",
    now,
  });

  const first = await consumeOAuthState(pool as never, "s1", "nonce-1", { now });
  assert.ok(first);
  assert.equal(first!.code_verifier, "verifier");
  assert.equal(first!.browser_nonce, "nonce-1");
  assert.equal(first!.mode, "popup");

  const second = await consumeOAuthState(pool as never, "s1", "nonce-1", { now });
  assert.equal(second, null);
});

test("wrong browser nonce does not consume the row", async () => {
  const { pool, rows } = makeFakePool();
  const now = new Date("2026-01-01T00:00:00.000Z");
  await saveOAuthState(pool as never, {
    state: "s1",
    code_verifier: "verifier",
    browser_nonce: "good-nonce",
    now,
  });

  const wrong = await consumeOAuthState(pool as never, "s1", "bad-nonce", { now });
  assert.equal(wrong, null);
  assert.ok(rows.has("s1"));

  const ok = await consumeOAuthState(pool as never, "s1", "good-nonce", { now });
  assert.ok(ok);
  assert.equal(ok!.code_verifier, "verifier");
});

test("missing browser nonce returns null without consume", async () => {
  const { pool, rows } = makeFakePool();
  const now = new Date("2026-01-01T00:00:00.000Z");
  await saveOAuthState(pool as never, {
    state: "s1",
    code_verifier: "verifier",
    browser_nonce: "n",
    now,
  });
  assert.equal(await consumeOAuthState(pool as never, "s1", "", { now }), null);
  assert.ok(rows.has("s1"));
});

test("consumeOAuthState returns null for expired rows", async () => {
  const { pool } = makeFakePool();
  const created = new Date("2026-01-01T00:00:00.000Z");
  await saveOAuthState(pool as never, {
    state: "expired",
    code_verifier: "v",
    browser_nonce: "n",
    now: created,
    ttlMs: 1000,
  });
  const later = new Date(created.getTime() + 5000);
  const got = await consumeOAuthState(pool as never, "expired", "n", { now: later });
  assert.equal(got, null);
});

test("cleanupExpiredOAuthStates removes only expired", async () => {
  const now = new Date("2026-01-01T00:10:00.000Z");
  const { pool, rows } = makeFakePool([
    {
      state: "old",
      code_verifier: "a",
      mode: "redirect",
      browser_nonce: "n1",
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      expires_at: new Date("2026-01-01T00:05:00.000Z"),
    },
    {
      state: "fresh",
      code_verifier: "b",
      mode: "redirect",
      browser_nonce: "n2",
      created_at: new Date("2026-01-01T00:08:00.000Z"),
      expires_at: new Date("2026-01-01T00:18:00.000Z"),
    },
  ]);
  const removed = await cleanupExpiredOAuthStates(pool as never, { now });
  assert.equal(removed, 1);
  assert.ok(!rows.has("old"));
  assert.ok(rows.has("fresh"));
});

test("saved row shape includes expires after TTL", async () => {
  const { pool } = makeFakePool();
  const now = new Date("2026-06-01T12:00:00.000Z");
  const saved: OAuthPendingState = await saveOAuthState(pool as never, {
    state: "s",
    code_verifier: "cv",
    browser_nonce: "bn",
    now,
  });
  assert.equal(saved.expires_at.getTime() - now.getTime(), OAUTH_STATE_TTL_MS);
});
