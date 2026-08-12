import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTweetTextFromOEmbedHtml,
  MAX_STORED_TWEET_TEXT_CHARS,
} from "./oembedTweetText.js";
import { verifyPublicPostViaOEmbed, X_OEMBED_ENDPOINT } from "./xOEmbed.js";

const SAMPLE_HTML = `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Hello <a href="https://twitter.com/Alice">@Alice</a> &amp; friends<br>line two <a href="https://t.co/abc">https://t.co/abc</a> #nature 😀</p>&mdash; Bob (@bob) <a href="https://twitter.com/bob/status/1">May 5, 2014</a></blockquote>\n<script async src="https://platform.x.com/widgets.js" charset="utf-8"></script>`;

test("extractTweetTextFromOEmbedHtml keeps post paragraph only and decodes entities", () => {
  const text = extractTweetTextFromOEmbedHtml(SAMPLE_HTML);
  assert.ok(text);
  assert.match(text!, /Hello @Alice & friends/);
  assert.match(text!, /line two/);
  assert.match(text!, /#nature/);
  assert.match(text!, /😀/);
  assert.doesNotMatch(text!, /Bob \(@bob\)/);
  assert.doesNotMatch(text!, /widgets\.js|script/i);
  assert.doesNotMatch(text!, /<a |<p |blockquote/i);
});

test("extractTweetTextFromOEmbedHtml rejects arbitrary blockquote and truncates long text", () => {
  assert.equal(extractTweetTextFromOEmbedHtml("<blockquote><p>no class</p></blockquote>"), null);
  assert.equal(extractTweetTextFromOEmbedHtml("<blockquote class=\"twitter-tweet\"></blockquote>"), null);
  assert.equal(extractTweetTextFromOEmbedHtml(""), null);
  const long = `<blockquote class="twitter-tweet"><p>${"x".repeat(MAX_STORED_TWEET_TEXT_CHARS + 50)}</p></blockquote>`;
  const out = extractTweetTextFromOEmbedHtml(long);
  assert.equal(out?.length, MAX_STORED_TWEET_TEXT_CHARS);
});

function oembedJson(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://twitter.com/alice/status/123",
    author_name: "Alice",
    author_url: "https://twitter.com/alice",
    html: SAMPLE_HTML.replace(/@bob/g, "@alice").replace(/\/bob\//g, "/alice/"),
    type: "rich",
    provider_name: "Twitter",
    provider_url: "https://twitter.com",
    version: "1.0",
    ...overrides,
  };
}

test("verifyPublicPostViaOEmbed requests only the fixed endpoint with redirect:manual", async () => {
  let requested = "";
  let fetchInit: RequestInit | undefined;
  const result = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async (url, init) => {
      requested = String(url);
      fetchInit = init;
      assert.ok(requested.startsWith(`${X_OEMBED_ENDPOINT}?`));
      assert.doesNotMatch(requested, /^https:\/\/x\.com\/alice\/status/);
      assert.match(requested, /url=https%3A%2F%2Fx\.com%2Falice%2Fstatus%2F123/);
      return new Response(JSON.stringify(oembedJson()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(fetchInit?.redirect, "manual");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verificationMethod, "x_oembed_author_handle");
    assert.equal(result.authorHandle, "alice");
    assert.equal(result.tweetId, "123");
    assert.match(result.tweetText, /Hello/);
  }
});

test("verifyPublicPostViaOEmbed rejects 3xx without a second request", async () => {
  let calls = 0;
  const result = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "oembed_unavailable");
});

test("verifyPublicPostViaOEmbed rejects author mismatch, unavailable, and malformed shapes", async () => {
  const mismatch = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          oembedJson({
            author_url: "https://x.com/eve",
            url: "https://x.com/eve/status/123",
          })
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.reason, "oembed_author_mismatch");

  const responseUrlAuthorMismatch = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          oembedJson({
            author_url: "https://x.com/alice",
            url: "https://x.com/eve/status/123",
          })
        ),
        { status: 200 }
      ),
  });
  assert.equal(responseUrlAuthorMismatch.ok, false);
  if (!responseUrlAuthorMismatch.ok) {
    assert.equal(responseUrlAuthorMismatch.reason, "oembed_author_mismatch");
  }

  const missing = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () => new Response("{}", { status: 404 }),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "tweet_unavailable");

  const badJson = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () => new Response("not-json", { status: 200 }),
  });
  assert.equal(badJson.ok, false);

  const wrongId = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () =>
      new Response(JSON.stringify(oembedJson({ url: "https://x.com/alice/status/999" })), {
        status: 200,
      }),
  });
  assert.equal(wrongId.ok, false);

  const timeline = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          oembedJson({
            html: `<a class="twitter-timeline" href="https://x.com/alice">Tweets</a><script src="https://platform.x.com/widgets.js"></script>`,
            url: "https://x.com/alice",
          })
        ),
        { status: 200 }
      ),
  });
  assert.equal(timeline.ok, false);

  const noText = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          oembedJson({
            html: `<blockquote class="twitter-tweet"></blockquote><script></script>`,
          })
        ),
        { status: 200 }
      ),
  });
  assert.equal(noText.ok, false);
  if (!noText.ok) assert.equal(noText.reason, "oembed_text_missing");
});

test("verifyPublicPostViaOEmbed rejects missing/wrong provider and non-rich type", async () => {
  for (const overrides of [
    { provider_name: "" },
    { provider_name: "YouTube" },
    { provider_name: undefined },
    { type: "" },
    { type: "link" },
    { type: undefined },
  ] as Array<Record<string, unknown>>) {
    const payload: Record<string, unknown> = { ...oembedJson() };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete payload[k];
      else payload[k] = v;
    }
    const result = await verifyPublicPostViaOEmbed({
      canonicalPostUrl: "https://x.com/alice/status/123",
      expectedTweetId: "123",
      expectedHandle: "alice",
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
    });
    assert.equal(result.ok, false, `expected reject for ${JSON.stringify(overrides)}`);
    if (!result.ok) assert.equal(result.reason, "oembed_malformed");
  }
});

test("verifyPublicPostViaOEmbed rejects insecure or malformed response urls", async () => {
  const badUrls = [
    "http://x.com/alice/status/123",
    "https://evil.com/alice/status/123",
    "https://x.com/alice/status/123/extra",
    "https://x.com/alice/status/123?s=20",
    "https://x.com/alice/status/123#frag",
    "https://user:pass@x.com/alice/status/123",
    "https://x.com:8443/alice/status/123",
    "https://x.com/alice",
  ];
  for (const url of badUrls) {
    const result = await verifyPublicPostViaOEmbed({
      canonicalPostUrl: "https://x.com/alice/status/123",
      expectedTweetId: "123",
      expectedHandle: "alice",
      fetchImpl: async () =>
        new Response(JSON.stringify(oembedJson({ url })), { status: 200 }),
    });
    assert.equal(result.ok, false, `expected reject for ${url}`);
  }

  const arbitraryBlockquote = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: "https://x.com/alice/status/123",
    expectedTweetId: "123",
    expectedHandle: "alice",
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          oembedJson({
            html: `<blockquote><p>not a tweet widget</p></blockquote>`,
          })
        ),
        { status: 200 }
      ),
  });
  assert.equal(arbitraryBlockquote.ok, false);
});
