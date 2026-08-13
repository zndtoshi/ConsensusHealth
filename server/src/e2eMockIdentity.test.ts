import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildE2EMockHandle,
  deterministicMockHandleSuffix,
  deterministicMockUserId,
  E2E_MOCK_HANDLE_MAX_LEN,
  E2E_MOCK_HANDLE_SUFFIX_LEN,
  isConsensusHealthE2E,
  parseE2EOauthFailMode,
  parseE2EUserKey,
  resolveE2EMockIdentity,
} from "./e2eMockIdentity.js";

/** Keys exercised by launch Playwright + common short keys + long shared prefixes. */
const CURRENT_E2E_KEYS = [
  "u1",
  "u2",
  "ft_neutral",
  "ft_against",
  "ft_approve",
  "chg_stance",
  "auto_bip54",
  "auto_bip448",
  "auto_bip460",
  "stanced_bip54",
  "stanced_bip448",
  "stanced_bip460",
  "auto_bip110",
  "iso_multi",
  "explain_full",
  "oauth_ok",
  "oauth_deny",
  "oauth_token",
  "oauth_exp",
  "oauth_wb",
  "del_ui",
  "rl_acct",
  "rl_other",
  // Extra long common-prefix stress keys
  "stanced_bip999",
  "stanced_bip1000",
  "stanced_bip_alpha",
  "stanced_bip_beta",
  "user_long_prefix_one",
  "user_long_prefix_two",
  "user_long_prefix_three",
];

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

test("parseE2EOauthFailMode accepts token|deny|expired only", () => {
  assert.equal(parseE2EOauthFailMode("token"), "token");
  assert.equal(parseE2EOauthFailMode("DENY"), "deny");
  assert.equal(parseE2EOauthFailMode("expired"), "expired");
  assert.equal(parseE2EOauthFailMode("other"), null);
});

test("handle suffix uses full fixed-width base36 of the 32-bit digest", () => {
  const suffix = deterministicMockHandleSuffix("stanced_bip54");
  assert.equal(suffix.length, E2E_MOCK_HANDLE_SUFFIX_LEN);
  assert.match(suffix, /^[0-9a-z]+$/);
  assert.equal(deterministicMockHandleSuffix("stanced_bip54"), suffix);
  assert.notEqual(suffix, deterministicMockHandleSuffix("stanced_bip448"));
});

test("buildE2EMockHandle is deterministic, X-safe, and <=15 chars", () => {
  const a = buildE2EMockHandle("explain_full");
  const b = buildE2EMockHandle("explain_full");
  assert.equal(a, b);
  assert.ok(a.length <= E2E_MOCK_HANDLE_MAX_LEN);
  assert.equal(a.length, E2E_MOCK_HANDLE_MAX_LEN);
  assert.match(a, /^[a-z0-9_]+$/);
  assert.ok(a.startsWith("e2e_"));
  assert.equal(a.slice(-E2E_MOCK_HANDLE_SUFFIX_LEN), deterministicMockHandleSuffix("explain_full"));
});

test("buildE2EMockHandle does not collide across current and long shared-prefix keys", () => {
  const handles = CURRENT_E2E_KEYS.map((k) => buildE2EMockHandle(k));
  assert.equal(new Set(handles).size, handles.length, `collision among ${handles.join(",")}`);
  const stanced = ["stanced_bip54", "stanced_bip448", "stanced_bip460"].map(buildE2EMockHandle);
  assert.equal(new Set(stanced).size, 3);
  assert.ok(!stanced.every((h) => h === "e2e_stanced_bip"));
});

test("resolveE2EMockIdentity is deterministic and isolated per key", () => {
  const a = resolveE2EMockIdentity("u1");
  const b = resolveE2EMockIdentity("u1");
  const c = resolveE2EMockIdentity("u2");
  assert.deepEqual(a, b);
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.handle, c.handle);
  assert.equal(a.handle, buildE2EMockHandle("u1"));
  assert.equal(c.handle, buildE2EMockHandle("u2"));
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
  const handle = buildE2EMockHandle("u1");
  try {
    const { verifyPublicPostViaOEmbed } = await import("./xOEmbed.js");
    const result = await verifyPublicPostViaOEmbed({
      canonicalPostUrl: `https://x.com/${handle}/status/1234567890123456789`,
      expectedTweetId: "1234567890123456789",
      expectedHandle: handle,
      fetchImpl: async () => {
        throw new Error("live oEmbed must not be called in E2E");
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.authorHandle, handle);
      assert.match(result.tweetText, /E2E mock explanation/);
    }
    const unavailable = await verifyPublicPostViaOEmbed({
      canonicalPostUrl: `https://x.com/${handle}/status/9990000000000000001`,
      expectedTweetId: "9990000000000000001",
      expectedHandle: handle,
      fetchImpl: async () => {
        throw new Error("live oEmbed must not be called in E2E");
      },
    });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.reason, "oembed_unavailable");
  } finally {
    if (prevE2e == null) delete process.env.CONSENSUSHEALTH_E2E;
    else process.env.CONSENSUSHEALTH_E2E = prevE2e;
    if (prevMock == null) delete process.env.X_OAUTH_MOCK;
    else process.env.X_OAUTH_MOCK = prevMock;
    if (prevNode == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  }
});
