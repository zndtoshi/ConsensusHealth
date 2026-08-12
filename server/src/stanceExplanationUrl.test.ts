import test from "node:test";
import assert from "node:assert/strict";
import { parseStanceExplanationUrl } from "./stanceExplanationUrl.js";

const HANDLE = "alice";

test("parseStanceExplanationUrl accepts named-user X/Twitter status URLs and canonicalizes", () => {
  const cases = [
    "https://x.com/alice/status/1234567890123456789",
    "https://www.x.com/Alice/status/1234567890123456789?s=20",
    "https://twitter.com/alice/status/1234567890123456789#extra",
    "https://www.twitter.com/alice/status/1234567890123456789",
  ];
  for (const raw of cases) {
    const parsed = parseStanceExplanationUrl(raw, HANDLE);
    assert.equal(parsed.ok, true, raw);
    if (!parsed.ok) continue;
    assert.equal(parsed.value.username, "alice");
    assert.equal(parsed.value.tweetId, "1234567890123456789");
    assert.equal(parsed.value.canonicalUrl, "https://x.com/alice/status/1234567890123456789");
  }
});

test("parseStanceExplanationUrl rejects disallowed shapes", () => {
  const rejected = [
    "",
    "not a url",
    "http://x.com/alice/status/1",
    "https://x.com.evil.com/alice/status/1",
    "https://evil-x.com/alice/status/1",
    "https://x.com:443/alice/status/1",
    "https://user:pass@x.com/alice/status/1",
    "https://x.com/alice",
    "https://x.com/alice/status/",
    "https://x.com/i/web/status/123",
    "https://x.com/intent/tweet?text=hi",
    "https://t.co/abcdef",
    "https://x.com/alice/status/abc",
    "https://x.com/alice/status/12.34",
    "https://mobile.twitter.com/alice/status/1",
  ];
  for (const raw of rejected) {
    const parsed = parseStanceExplanationUrl(raw, HANDLE);
    assert.equal(parsed.ok, false, raw);
  }
});

test("parseStanceExplanationUrl requires session handle match and preserves snowflake digits", () => {
  const id = "18446744073709551615";
  const ok = parseStanceExplanationUrl(`https://x.com/alice/status/${id}`, "Alice");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.tweetId, id);

  const mismatch = parseStanceExplanationUrl(`https://x.com/bob/status/${id}`, "alice");
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error, "username_mismatch");
});

test("parseStanceExplanationUrl rejects oversized input", () => {
  const long = `https://x.com/alice/status/1${"0".repeat(600)}`;
  const parsed = parseStanceExplanationUrl(long, HANDLE);
  assert.equal(parsed.ok, false);
});
