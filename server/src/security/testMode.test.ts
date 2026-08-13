import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoTestSwitchesInProduction,
  isStrictTestMode,
  resolveE2eServeDist,
  resolveForceListen,
  resolveHelmetProd,
  resolveXOauthMock,
} from "./testMode.js";

const base = {
  NODE_ENV: "test",
  CONSENSUSHEALTH_E2E: "1",
} as const;

test("isStrictTestMode requires NODE_ENV=test and CONSENSUSHEALTH_E2E", () => {
  assert.equal(isStrictTestMode({ NODE_ENV: "test", CONSENSUSHEALTH_E2E: "1" }), true);
  assert.equal(isStrictTestMode({ NODE_ENV: "test", CONSENSUSHEALTH_E2E: "0" }), false);
  assert.equal(isStrictTestMode({ NODE_ENV: "development", CONSENSUSHEALTH_E2E: "1" }), false);
  assert.equal(isStrictTestMode({ NODE_ENV: "production", CONSENSUSHEALTH_E2E: "1" }), false);
  assert.equal(
    isStrictTestMode({
      NODE_ENV: "development",
      CONSENSUSHEALTH_STRICT_TEST: "1",
      CONSENSUSHEALTH_E2E: "1",
    }),
    true
  );
});

test("resolvers return true only in strict test mode when flag is set", () => {
  assert.equal(resolveXOauthMock({ ...base, X_OAUTH_MOCK: "1" }), true);
  assert.equal(resolveE2eServeDist({ ...base, E2E_SERVE_DIST: "1" }), true);
  assert.equal(resolveForceListen({ ...base, FORCE_LISTEN: "1" }), true);
  assert.equal(resolveHelmetProd({ ...base, HELMET_PROD: "1" }), true);

  assert.equal(resolveXOauthMock({ ...base, X_OAUTH_MOCK: "0" }), false);
  assert.equal(resolveXOauthMock({ NODE_ENV: "development", X_OAUTH_MOCK: "1" }), false);
  assert.equal(
    resolveXOauthMock({ NODE_ENV: "production", CONSENSUSHEALTH_E2E: "1", X_OAUTH_MOCK: "1" }),
    false
  );
});

test("mock cannot enable in production even with all switches set", () => {
  const prod = {
    NODE_ENV: "production",
    CONSENSUSHEALTH_E2E: "1",
    X_OAUTH_MOCK: "1",
    E2E_SERVE_DIST: "1",
    FORCE_LISTEN: "1",
    HELMET_PROD: "1",
    X_OAUTH_MOCK_USER_ID: "9000000000000000001",
    X_OAUTH_MOCK_HANDLE: "e2e_mock_user",
  };
  assert.equal(isStrictTestMode(prod), false);
  assert.equal(resolveXOauthMock(prod), false);
  assert.equal(resolveE2eServeDist(prod), false);
  assert.equal(resolveForceListen(prod), false);
});

test("assertNoTestSwitchesInProduction rejects every test switch", () => {
  const switches = [
    "X_OAUTH_MOCK",
    "E2E_SERVE_DIST",
    "FORCE_LISTEN",
    "CONSENSUSHEALTH_E2E",
    "HELMET_PROD",
    "X_OAUTH_MOCK_USER_ID",
    "X_OAUTH_MOCK_HANDLE",
    "X_OAUTH_MOCK_NAME",
    "X_OAUTH_MOCK_AVATAR",
  ] as const;

  for (const key of switches) {
    assert.throws(
      () =>
        assertNoTestSwitchesInProduction(
          { NODE_ENV: "production", [key]: key.startsWith("X_OAUTH_MOCK_") ? "x" : "1" },
          { throwOnFatal: true }
        ),
      /test-only switch/
    );
  }

  assert.doesNotThrow(() =>
    assertNoTestSwitchesInProduction(
      { NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) },
      { throwOnFatal: true }
    )
  );

  assert.doesNotThrow(() =>
    assertNoTestSwitchesInProduction(
      { NODE_ENV: "test", X_OAUTH_MOCK: "1", CONSENSUSHEALTH_E2E: "1" },
      { throwOnFatal: true }
    )
  );
});
