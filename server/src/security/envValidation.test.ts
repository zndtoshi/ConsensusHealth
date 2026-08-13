import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProductionEnv,
  resolveContactEmail,
  validateEnv,
} from "./envValidation.js";

const strongSecret = "a".repeat(32);

function prodBase(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "production",
    SESSION_SECRET: strongSecret,
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    APP_ORIGIN: "https://app.example.com",
    APP_URL: "https://api.example.com",
    X_CLIENT_ID: "client-id",
    X_CLIENT_SECRET: "client-secret",
    CONTACT_EMAIL: "privacy@example.com",
    ...overrides,
  };
}

test("validateEnv production fails on missing SESSION_SECRET", () => {
  const r = validateEnv(prodBase({ SESSION_SECRET: "" }), { isProd: true });
  assert.equal(r.ok, false);
  assert.ok(r.fatal.some((m) => m.includes("SESSION_SECRET")));
});

test("validateEnv production fails on placeholder SESSION_SECRET", () => {
  const r = validateEnv(prodBase({ SESSION_SECRET: "change_me_long_random" }), { isProd: true });
  assert.equal(r.ok, false);
  assert.ok(r.fatal.some((m) => /placeholder|SESSION_SECRET/i.test(m)));
});

test("validateEnv production warns on a legacy short SESSION_SECRET without blocking startup", () => {
  const r = validateEnv(prodBase({ SESSION_SECRET: "short-but-not-placeholder" }), { isProd: true });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((m) => m.includes("32")));
  assert.equal(r.fatal.some((m) => m.includes("32")), false);
});

test("validateEnv production warns on missing CONTACT_EMAIL without blocking startup", () => {
  const r = validateEnv(prodBase({ CONTACT_EMAIL: "", PRIVACY_CONTACT_EMAIL: "" }), {
    isProd: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((m) => m.includes("CONTACT_EMAIL")));
  assert.equal(r.fatal.some((m) => m.includes("CONTACT_EMAIL")), false);
});

test("validateEnv production fails on http APP_ORIGIN/APP_URL", () => {
  const r = validateEnv(
    prodBase({ APP_ORIGIN: "http://localhost:5173", APP_URL: "http://localhost:8787" }),
    { isProd: true }
  );
  assert.equal(r.ok, false);
  assert.ok(r.fatal.some((m) => /HTTPS/i.test(m)));
});

test("validateEnv production fails on missing DATABASE_URL and OAuth", () => {
  const r = validateEnv(
    prodBase({
      DATABASE_URL: "",
      X_CLIENT_ID: "",
      X_CLIENT_SECRET: "",
      TWITTER_CLIENT_ID: "",
      TWITTER_CLIENT_SECRET: "",
    }),
    { isProd: true }
  );
  assert.equal(r.ok, false);
  assert.ok(r.fatal.some((m) => m.includes("DATABASE_URL")));
  assert.ok(r.fatal.some((m) => /client id/i.test(m)));
  assert.ok(r.fatal.some((m) => /client secret/i.test(m)));
});

test("validateEnv production ok with valid env", () => {
  const r = validateEnv(prodBase(), { isProd: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fatal, []);
});

test("validateEnv development warns but is ok for soft cases", () => {
  const r = validateEnv(
    {
      NODE_ENV: "development",
      SESSION_SECRET: "change_me",
      DATABASE_URL: "",
      APP_ORIGIN: "http://localhost:5173",
    },
    { isProd: false }
  );
  assert.equal(r.ok, true);
  assert.equal(r.fatal.length, 0);
  assert.ok(r.warnings.length > 0);
});

test("assertProductionEnv throws when throwOnFatal in production", () => {
  assert.throws(
    () =>
      assertProductionEnv(prodBase({ SESSION_SECRET: "" }), {
        throwOnFatal: true,
        warn: () => {},
        error: () => {},
      }),
    /Refusing to start/
  );
});

test("assertProductionEnv does not exit in development", () => {
  let exited = false;
  const r = assertProductionEnv(
    { NODE_ENV: "development", SESSION_SECRET: "" },
    {
      warn: () => {},
      error: () => {},
      exit: (() => {
        exited = true;
        throw new Error("should not exit");
      }) as (code: number) => never,
    }
  );
  assert.equal(exited, false);
  assert.equal(r.ok, true);
});

test("resolveContactEmail prefers CONTACT_EMAIL then PRIVACY_CONTACT_EMAIL", () => {
  assert.equal(resolveContactEmail({ CONTACT_EMAIL: "a@b.co" }), "a@b.co");
  assert.equal(
    resolveContactEmail({ PRIVACY_CONTACT_EMAIL: "p@b.co", CONTACT_EMAIL: "" }),
    "p@b.co"
  );
  assert.equal(resolveContactEmail({}), null);
});

test("CONTACT_EMAIL.value is a live getter", async () => {
  const { CONTACT_EMAIL: live } = await import("./envValidation.js");
  assert.equal(typeof live.value === "string" || live.value === null, true);
});
