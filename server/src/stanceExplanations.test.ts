import test from "node:test";
import assert from "node:assert/strict";
import { fetchXTweetById } from "./xApiUsers.js";
import {
  snippetExplanationText,
  toPublicExplanation,
  verifyAndUpsertStanceExplanation,
  STANCE_EXPLANATION_USER_MESSAGES,
} from "./stanceExplanations.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oembedFor(handle: string, tweetId: string, text = "Verified explanation text") {
  return {
    url: `https://x.com/${handle}/status/${tweetId}`,
    author_name: handle,
    author_url: `https://x.com/${handle}`,
    html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">${text}</p>&mdash; ${handle} (@${handle}) <a href="https://x.com/${handle}/status/${tweetId}">Jan 1, 2024</a></blockquote><script async src="https://platform.x.com/widgets.js"></script>`,
    type: "rich",
    provider_name: "Twitter",
    provider_url: "https://twitter.com",
    version: "1.0",
  };
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

test("oEmbed verification succeeds with no X credentials configured", async () => {
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("SELECT stance")) {
        return { rows: [{ stance: "against" }] };
      }
      if (String(sql).includes("INSERT INTO user_proposal_stance_explanations")) {
        assert.equal(params[5], null, "oEmbed-only must not invent a stable author_x_user_id");
        assert.equal(params[8], "x_oembed_author_handle");
        return {
          rows: [
            {
              proposal_id: params[1],
              tweet_id: params[2],
              canonical_url: params[3],
              tweet_text: params[4],
              author_handle: params[6],
              stance_at_verification: params[7],
              verification_method: params[8],
              verified_at: new Date().toISOString(),
              unavailable_at: null,
            },
          ],
        };
      }
      throw new Error(`unexpected sql ${sql}`);
    },
  };
  const prevBearer = process.env.X_BEARER_TOKEN;
  const prevTw = process.env.TWITTER_BEARER_TOKEN;
  delete process.env.X_BEARER_TOKEN;
  delete process.env.TWITTER_BEARER_TOKEN;

  try {
    const result = await verifyAndUpsertStanceExplanation(pool as never, {
      xUserId: "111",
      handle: "alice",
      proposalId: "bip54",
      tweetUrl: "https://x.com/alice/status/1498836693482356740?s=20",
      fetchImpl: async (url) => {
        const u = String(url);
        assert.match(u, /^https:\/\/publish\.x\.com\/oembed\?/);
        assert.doesNotMatch(u, /^https:\/\/x\.com\//);
        assert.match(u, /1498836693482356740/);
        return jsonResponse(
          200,
          oembedFor("alice", "1498836693482356740", "Public oEmbed text")
        );
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.explanation.tweet_id, "1498836693482356740");
      assert.equal(result.explanation.tweet_text, "Public oEmbed text");
      assert.equal(result.explanation.verification_method, "x_oembed_author_handle");
      assert.doesNotMatch(result.explanation.tweet_text, /</);
    }
  } finally {
    if (prevBearer != null) process.env.X_BEARER_TOKEN = prevBearer;
    else delete process.env.X_BEARER_TOKEN;
    if (prevTw != null) process.env.TWITTER_BEARER_TOKEN = prevTw;
    else delete process.env.TWITTER_BEARER_TOKEN;
  }
});

test("optional bearer author_id mismatch still rejects after oEmbed handle match", async () => {
  const pool = {
    query: async (sql: string) => {
      if (String(sql).includes("SELECT stance")) return { rows: [{ stance: "against" }] };
      throw new Error("should not insert");
    },
  };
  process.env.X_BEARER_TOKEN = "test-bearer";
  try {
    const result = await verifyAndUpsertStanceExplanation(pool as never, {
      xUserId: "111",
      handle: "alice",
      proposalId: "bip54",
      tweetUrl: "https://x.com/alice/status/42",
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("publish.x.com/oembed")) {
          return jsonResponse(200, oembedFor("alice", "42"));
        }
        return jsonResponse(200, {
          data: { id: "42", author_id: "999", text: "api" },
        });
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "tweet_author_mismatch");
      assert.equal(result.message, STANCE_EXPLANATION_USER_MESSAGES.tweet_author_mismatch);
    }
  } finally {
    delete process.env.X_BEARER_TOKEN;
  }
});

test("invalid bearer does not block successful oEmbed verification", async () => {
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("SELECT stance")) return { rows: [{ stance: "against" }] };
      if (String(sql).includes("INSERT INTO")) {
        assert.equal(params[5], null);
        assert.equal(params[8], "x_oembed_author_handle");
        return {
          rows: [
            {
              proposal_id: params[1],
              tweet_id: params[2],
              canonical_url: params[3],
              tweet_text: params[4],
              author_handle: params[6],
              stance_at_verification: params[7],
              verification_method: params[8],
              verified_at: new Date().toISOString(),
            },
          ],
        };
      }
      throw new Error("unexpected");
    },
  };
  process.env.X_BEARER_TOKEN = "bad-token";
  try {
    const result = await verifyAndUpsertStanceExplanation(pool as never, {
      xUserId: "111",
      handle: "alice",
      proposalId: "bip54",
      tweetUrl: "https://x.com/alice/status/7",
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("publish.x.com/oembed")) {
          return jsonResponse(200, oembedFor("alice", "7", "oembed wins"));
        }
        return jsonResponse(401, { title: "Unauthorized" });
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.explanation.verification_method, "x_oembed_author_handle");
      assert.equal(result.explanation.tweet_text, "oembed wins");
    }
  } finally {
    delete process.env.X_BEARER_TOKEN;
  }
});

test("successful optional API cross-check stores stable author_x_user_id", async () => {
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes("SELECT stance")) return { rows: [{ stance: "against" }] };
      if (String(sql).includes("INSERT INTO")) {
        assert.equal(params[5], "111");
        assert.equal(params[8], "x_api_author_id");
        return {
          rows: [
            {
              proposal_id: params[1],
              tweet_id: params[2],
              canonical_url: params[3],
              tweet_text: params[4],
              author_handle: params[6],
              stance_at_verification: params[7],
              verification_method: params[8],
              verified_at: new Date().toISOString(),
            },
          ],
        };
      }
      throw new Error("unexpected");
    },
  };
  process.env.X_BEARER_TOKEN = "test-bearer";
  try {
    const result = await verifyAndUpsertStanceExplanation(pool as never, {
      xUserId: "111",
      handle: "alice",
      proposalId: "bip54",
      tweetUrl: "https://x.com/alice/status/88",
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("publish.x.com/oembed")) {
          return jsonResponse(200, oembedFor("alice", "88", "oembed"));
        }
        return jsonResponse(200, {
          data: { id: "88", author_id: "111", text: "api text" },
        });
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.explanation.verification_method, "x_api_author_id");
      assert.equal(result.explanation.tweet_text, "api text");
    }
  } finally {
    delete process.env.X_BEARER_TOKEN;
  }
});
