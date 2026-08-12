import test from "node:test";
import assert from "node:assert/strict";
import { fetchXTweetById } from "./xApiUsers.js";
import {
  snippetExplanationText,
  toPublicExplanation,
} from "./stanceExplanations.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("fetchXTweetById preserves long digit ids and maps fields", async () => {
  const id = "18446744073709551615";
  const author = "9007199254740993";
  const tweet = await fetchXTweetById("bearer", id, {
    fetchImpl: async (url) => {
      assert.match(String(url), new RegExp(`/2/tweets/${id}`));
      assert.doesNotMatch(String(url), /https?:\/\/x\.com\//);
      return jsonResponse(200, {
        data: {
          id,
          author_id: author,
          text: "Verified explanation text",
          created_at: "2024-01-02T03:04:05.000Z",
        },
      });
    },
  });
  assert.deepEqual(tweet, {
    id,
    authorId: author,
    text: "Verified explanation text",
    createdAt: "2024-01-02T03:04:05.000Z",
  });
});

test("fetchXTweetById returns null for unavailable posts", async () => {
  const tweet = await fetchXTweetById("bearer", "1", {
    fetchImpl: async () => jsonResponse(404, { errors: [{ title: "Not Found" }] }),
  });
  assert.equal(tweet, null);
});

test("fetchXTweetById surfaces provider failures", async () => {
  await assert.rejects(
    () =>
      fetchXTweetById("bearer", "1", {
        fetchImpl: async () => jsonResponse(500, { title: "boom" }),
      }),
    /X API 500/
  );
});

test("toPublicExplanation hides mismatched or missing explanations", () => {
  const dto = {
    proposal_id: "bip54",
    tweet_id: "1",
    canonical_url: "https://x.com/a/status/1",
    tweet_text: "hello",
    author_handle: "a",
    verified_at: "2024-01-01T00:00:00.000Z",
    stance_at_verification: "against" as const,
  };
  assert.equal(toPublicExplanation(dto, "against")?.tweet_id, "1");
  assert.equal(toPublicExplanation(dto, "approve"), null);
  assert.equal(toPublicExplanation(null, "against"), null);
});

test("snippetExplanationText truncates safely", () => {
  const long = "word ".repeat(80).trim();
  const snip = snippetExplanationText(long, 40);
  assert.ok(snip.length <= 40);
  assert.match(snip, /…$/);
  assert.equal(snippetExplanationText("short", 40), "short");
});

test("verify failures include safe user-facing messages without secrets", async () => {
  const { STANCE_EXPLANATION_USER_MESSAGES, verifyAndUpsertStanceExplanation } = await import(
    "./stanceExplanations.js"
  );
  const pool = {
    query: async () => ({ rows: [{ stance: "against" }] }),
  };
  process.env.X_BEARER_TOKEN = "";
  delete process.env.TWITTER_BEARER_TOKEN;
  delete process.env.X_CLIENT_ID;
  delete process.env.X_CLIENT_SECRET;
  const result = await verifyAndUpsertStanceExplanation(pool as never, {
    xUserId: "1",
    handle: "alice",
    proposalId: "bip54",
    tweetUrl: "https://x.com/alice/status/1",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "verification_unavailable");
    assert.equal(result.message, STANCE_EXPLANATION_USER_MESSAGES.verification_unavailable);
    assert.doesNotMatch(result.message || "", /Bearer|CLIENT_SECRET|token/i);
  }
});
