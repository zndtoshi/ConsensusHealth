import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCorsOriginAllowlist, createCorsOptions } from "./corsOrigins.js";

test("production allowlist only includes HTTPS configured origins + www variants", () => {
  const set = buildCorsOriginAllowlist(
    {
      APP_ORIGIN: "https://consensushealth.example",
      APP_URL: "https://api.consensushealth.example",
    },
    { isProd: true }
  );
  assert.ok(set.has("https://consensushealth.example"));
  assert.ok(set.has("https://www.consensushealth.example"));
  assert.ok(set.has("https://api.consensushealth.example"));
  assert.ok(!set.has("http://localhost:5173"));
});

test("production never auto-allows localhost even if APP_ORIGIN is http localhost", () => {
  const set = buildCorsOriginAllowlist(
    { APP_ORIGIN: "http://localhost:5173", APP_URL: "http://localhost:8787" },
    { isProd: true }
  );
  assert.equal(set.size, 0);
  assert.ok(!set.has("http://localhost:5173"));
});

test("development allows localhost and configured origins", () => {
  const set = buildCorsOriginAllowlist(
    { APP_ORIGIN: "http://localhost:5173", APP_URL: "http://127.0.0.1:8787" },
    { isProd: false }
  );
  assert.ok(set.has("http://localhost:5173"));
  assert.ok(set.has("http://127.0.0.1:8787"));
});

test("createCorsOptions allows listed origin and rejects others", () => {
  const opts = createCorsOptions({
    env: { APP_ORIGIN: "https://app.example.com" },
    isProd: true,
  });
  const originFn = opts.origin;
  assert.equal(typeof originFn, "function");
  if (typeof originFn !== "function") return;

  let allowed: boolean | Error | undefined;
  originFn("https://app.example.com", (err, ok) => {
    allowed = err ? err : Boolean(ok);
  });
  assert.equal(allowed, true);

  let rejected: unknown;
  originFn("https://evil.example", (err) => {
    rejected = err;
  });
  assert.ok(rejected instanceof Error);

  let noOrigin: boolean | Error | undefined;
  originFn(undefined as unknown as string, (err, ok) => {
    noOrigin = err ? err : Boolean(ok);
  });
  assert.equal(noOrigin, true);
});
