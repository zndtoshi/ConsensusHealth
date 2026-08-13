import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deterministicMockUserId,
  isConsensusHealthE2E,
  parseE2EUserKey,
  resolveE2EMockIdentity,
} from "./e2eMockIdentity.js";

test("isConsensusHealthE2E requires strict test mode and X_OAUTH_MOCK", () => {
  assert.equal(isConsensusHealthE2E({ NODE_ENV: "test", CONSENSUSHEALTH_E2E: "1", X_OAUTH_MOCK: "1" }), true);
  assert.equal(isConsensusHealthE2E({ NODE_ENV: "test", CONSENSUSHEALTH_E2E: "1", X_OAUTH_MOCK: "0" }), false);
  assert.equal(isConsensusHealthE2E({ NODE_ENV: "test", CONSENSUSHEALTH_E2E: "", X_OAUTH_MOCK: "1" }), false);
  assert.equal(
    isConsensusHealthE2E({ NODE_ENV: "development", CONSENSUSHEALTH_E2E: "1", X_OAUTH_MOCK: "1" }),
    false
  );
  assert.equal(
    isConsensusHealthE2E({ NODE_ENV: "production", CONSENSUSHEALTH_E2E: "1", X_OAUTH_MOCK: "1" }),
    false
  );
});

test("parseE2EUserKey accepts safe keys only", () => {
  assert.equal(parseE2EUserKey("u1"), "u1");
  assert.equal(parseE2EUserKey("Neutral_01"), "neutral_01");
  assert.equal(parseE2EUserKey("bad key"), null);
  assert.equal(parseE2EUserKey("../x"), null);
  assert.equal(parseE2EUserKey(""), null);
});

test("resolveE2EMockIdentity is deterministic and isolated per key", () => {
  const a = resolveE2EMockIdentity("u1");
  const b = resolveE2EMockIdentity("u1");
  const c = resolveE2EMockIdentity("u2");
  assert.deepEqual(a, b);
  assert.notEqual(a.id, c.id);
  assert.equal(a.handle, "e2e_u1");
  assert.equal(c.handle, "e2e_u2");
  assert.match(a.id, /^\d{10,19}$/);
  assert.equal(deterministicMockUserId("u1"), a.id);
});

test("resolveE2EMockIdentity falls back to env when key null", () => {
  const id = resolveE2EMockIdentity(null, {
    X_OAUTH_MOCK_USER_ID: "111",
    X_OAUTH_MOCK_HANDLE: "EnvHandle",
    X_OAUTH_MOCK_NAME: "Env Name",
  });
  assert.deepEqual(id, { id: "111", handle: "envhandle", name: "Env Name" });
});

test("E2E oEmbed stub short-circuits when flags set", async () => {
  const prevE2e = process.env.CONSENSUSHEALTH_E2E;
  const prevMock = process.env.X_OAUTH_MOCK;
  const prevNode = process.env.NODE_ENV;
  process.env.CONSENSUSHEALTH_E2E = "1";
  process.env.X_OAUTH_MOCK = "1";
  process.env.NODE_ENV = "test";
  try {
    const { verifyPublicPostViaOEmbed } = await import("./xOEmbed.js");
    const result = await verifyPublicPostViaOEmbed({
      canonicalPostUrl: "https://x.com/e2e_u1/status/1234567890123456789",
      expectedTweetId: "1234567890123456789",
      expectedHandle: "e2e_u1",
      fetchImpl: async () => {
        throw new Error("live oEmbed must not be called in E2E");
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.authorHandle, "e2e_u1");
      assert.match(result.tweetText, /E2E mock explanation/);
    }
  } finally {
    if (prevE2e == null) delete process.env.CONSENSUSHEALTH_E2E;
    else process.env.CONSENSUSHEALTH_E2E = prevE2e;
    if (prevMock == null) delete process.env.X_OAUTH_MOCK;
    else process.env.X_OAUTH_MOCK = prevMock;
    if (prevNode == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  }
});
