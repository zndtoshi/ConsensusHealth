import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractAvatarUrlFromProfileHtml,
  fetchXProfileAvatarUrl,
  isLikelyBlockedHtml,
  isTrustedXImageHost,
  isValidXHandle,
  type ProfilePageResponse,
} from "./xProfileScrape.js";

function page(opts: { status?: number; ok?: boolean; body?: string }): ProfilePageResponse {
  return {
    status: opts.status ?? 200,
    ok: opts.ok ?? (opts.status ?? 200) < 400,
    text: async () => opts.body ?? "",
  };
}

const goodProfileHtml =
  "x".repeat(600) +
  `<meta property="og:image" content="https://pbs.twimg.com/profile_images/123/abc_200x200.jpg">` +
  `<meta name="twitter:image" content="https://pbs.twimg.com/profile_banners/999/1611263959">`;

test("isTrustedXImageHost only trusts twimg hosts", () => {
  assert.equal(isTrustedXImageHost("pbs.twimg.com"), true);
  assert.equal(isTrustedXImageHost("abs.twimg.com"), true);
  assert.equal(isTrustedXImageHost("evil.com"), false);
  assert.equal(isTrustedXImageHost("pbs.twimg.com.evil.com"), false);
});

test("isValidXHandle enforces X handle rules", () => {
  assert.equal(isValidXHandle("adam3us"), true);
  assert.equal(isValidXHandle("@Adam3Us"), true);
  assert.equal(isValidXHandle("a".repeat(16)), false);
  assert.equal(isValidXHandle("bad-handle"), false);
  assert.equal(isValidXHandle(""), false);
});

test("extracts the avatar (og:image profile_images), not the banner", () => {
  const url = extractAvatarUrlFromProfileHtml(goodProfileHtml);
  assert.equal(url, "https://pbs.twimg.com/profile_images/123/abc_200x200.jpg");
});

test("ignores twitter:image banner when no og:image is present", () => {
  const html =
    "y".repeat(600) + `<meta name="twitter:image" content="https://pbs.twimg.com/profile_banners/999/1611263959">`;
  assert.equal(extractAvatarUrlFromProfileHtml(html), null);
});

test("falls back to an embedded pbs profile_images URL", () => {
  const html = "z".repeat(600) + `"profile_image_url_https":"https://pbs.twimg.com/profile_images/55/xy.jpg"`;
  assert.equal(extractAvatarUrlFromProfileHtml(html), "https://pbs.twimg.com/profile_images/55/xy.jpg");
});

test("decodes HTML entities in the extracted URL", () => {
  const html =
    "q".repeat(600) +
    `<meta property="og:image" content="https://pbs.twimg.com/profile_images/1/a.jpg?name=orig&amp;x=1">`;
  assert.equal(extractAvatarUrlFromProfileHtml(html), "https://pbs.twimg.com/profile_images/1/a.jpg?name=orig&x=1");
});

test("rejects untrusted hosts", () => {
  const html = "r".repeat(600) + `<meta property="og:image" content="https://evil.com/profile_images/1/a.jpg">`;
  assert.equal(extractAvatarUrlFromProfileHtml(html), null);
});

test("isLikelyBlockedHtml detects JS-wall and tiny bodies", () => {
  assert.equal(isLikelyBlockedHtml("<html>JavaScript is not available.</html>"), true);
  assert.equal(isLikelyBlockedHtml("short"), true);
  assert.equal(isLikelyBlockedHtml(goodProfileHtml), false);
});

test("fetchXProfileAvatarUrl returns the URL on a good page", async () => {
  const result = await fetchXProfileAvatarUrl("adam3us", async () => page({ status: 200, body: goodProfileHtml }));
  assert.deepEqual(result, { ok: true, url: "https://pbs.twimg.com/profile_images/123/abc_200x200.jpg" });
});

test("fetchXProfileAvatarUrl maps status codes and blocks", async () => {
  assert.deepEqual(await fetchXProfileAvatarUrl("a", async () => page({ status: 429 })), {
    ok: false,
    reason: "rate_limited",
  });
  assert.deepEqual(await fetchXProfileAvatarUrl("a", async () => page({ status: 403 })), {
    ok: false,
    reason: "forbidden",
  });
  assert.deepEqual(await fetchXProfileAvatarUrl("a", async () => page({ status: 404 })), {
    ok: false,
    reason: "not_found",
  });
  assert.deepEqual(
    await fetchXProfileAvatarUrl("a", async () => page({ status: 200, body: "JavaScript is not available." })),
    { ok: false, reason: "blocked" }
  );
  assert.deepEqual(
    await fetchXProfileAvatarUrl("a", async () => page({ status: 200, body: "x".repeat(600) })),
    { ok: false, reason: "no_avatar" }
  );
});

test("fetchXProfileAvatarUrl rejects invalid handles without fetching", async () => {
  let called = false;
  const result = await fetchXProfileAvatarUrl("bad-handle!", async () => {
    called = true;
    return page({ status: 200, body: goodProfileHtml });
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_handle" });
  assert.equal(called, false);
});

test("fetchXProfileAvatarUrl maps abort to timeout", async () => {
  const result = await fetchXProfileAvatarUrl("adam3us", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  });
  assert.deepEqual(result, { ok: false, reason: "timeout" });
});
