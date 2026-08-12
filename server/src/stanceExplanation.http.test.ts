/**
 * HTTP tests for production stance-explanation and admin-stance handlers.
 * Uses the same create*Handler factories wired by server/src/index.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { getProposalById, isFinalProposalStatus } from "./proposalCatalog.js";
import { resolveProposalAccess } from "./proposals.js";
import { isPrivilegedManualEditorHandle, normalizeStanceValue } from "./stanceHistory.js";
import { createStanceExplanationHandlers } from "./stanceExplanationHandlers.js";
import { createAdminStanceHandler } from "./adminStanceHandlers.js";
import {
  confirmExplanationForStance,
  deleteStanceExplanation,
  verifyAndUpsertStanceExplanation,
} from "./stanceExplanations.js";
import { canAccessAdminOnlyProposal, isFullUniversePreviewHandle } from "./proposalAccessPolicy.js";

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

type FakeRow = Record<string, unknown>;

function makeFakePool(seed?: {
  stances?: Array<{ x_user_id: string; proposal_id: string; stance: string }>;
  explanations?: Array<FakeRow>;
  community?: Array<FakeRow>;
}) {
  const stances = new Map(
    (seed?.stances || []).map((r) => [`${r.x_user_id}:${r.proposal_id}`, { ...r }])
  );
  const explanations = new Map(
    (seed?.explanations || []).map((r) => [`${r.x_user_id}:${r.proposal_id}`, { ...r }])
  );
  const community = new Map((seed?.community || []).map((r) => [String(r.x_user_id), { ...r }]));
  for (const r of seed?.community || []) {
    if (r.handle) community.set(`handle:${String(r.handle).toLowerCase()}`, { ...r });
  }

  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const text = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (text.startsWith("select stance from user_proposal_stances")) {
        const key = `${params[0]}:${params[1]}`;
        const row = stances.get(key);
        return { rows: row ? [{ stance: row.stance }] : [] };
      }
      if (text.includes("from user_proposal_stance_explanations") && text.includes("left join")) {
        // unused in these tests
        return { rows: [] };
      }
      if (text.startsWith("insert into user_proposal_stance_explanations")) {
        const [
          xUserId,
          proposalId,
          tweetId,
          canonicalUrl,
          tweetText,
          authorXUserId,
          authorHandle,
          stanceAt,
          verificationMethod,
        ] = params as string[];
        const row = {
          x_user_id: xUserId,
          proposal_id: proposalId,
          tweet_id: tweetId,
          canonical_url: canonicalUrl,
          tweet_text: tweetText,
          author_x_user_id: authorXUserId,
          author_handle: authorHandle,
          stance_at_verification: stanceAt,
          verification_method: verificationMethod,
          verified_at: new Date().toISOString(),
          unavailable_at: null,
        };
        explanations.set(`${xUserId}:${proposalId}`, row);
        return { rows: [row] };
      }
      if (text.startsWith("update user_proposal_stance_explanations")) {
        const [xUserId, proposalId, stance] = params as string[];
        const key = `${xUserId}:${proposalId}`;
        const existing = explanations.get(key);
        if (!existing) return { rows: [] };
        existing.stance_at_verification = stance;
        return { rows: [existing] };
      }
      if (text.startsWith("delete from user_proposal_stance_explanations")) {
        explanations.delete(`${params[0]}:${params[1]}`);
        return { rows: [] };
      }
      if (text.includes("from community_users where x_user_id")) {
        const row = community.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (text.includes("from community_users where lower(coalesce(handle")) {
        const row = community.get(`handle:${String(params[0]).toLowerCase()}`);
        return { rows: row ? [row] : [] };
      }
      if (text === "begin" || text === "commit" || text === "rollback") {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in fake pool: ${text.slice(0, 120)}`);
    },
    async connect() {
      return {
        query: (sql: string, params?: unknown[]) => pool.query(sql, params),
        release() {},
      };
    },
    _explanations: explanations,
    _stances: stances,
  };
  return pool;
}

function makeApp(opts: {
  session?: { x_user_id: string; handle: string } | null;
  pool: ReturnType<typeof makeFakePool>;
  fetchImpl?: typeof fetch;
  adminOnlyById?: Map<string, boolean>;
}) {
  const app = express();
  app.use(express.json());
  const session = opts.session ?? null;
  const adminOnlyById = opts.adminOnlyById;

  const resolveAccess = async ({
    rawProposal,
    sessionHandle,
  }: {
    rawProposal: unknown;
    sessionHandle: unknown;
  }) => {
    const access = resolveProposalAccess({
      rawProposal,
      sessionHandle,
      adminOnlyById,
    });
    const raw = String(rawProposal ?? "").trim();
    if (raw && adminOnlyById && !adminOnlyById.has(access.proposalId)) {
      return { ...access, allowed: false, known: false };
    }
    return { ...access, known: true };
  };

  const explanationHandlers = createStanceExplanationHandlers({
    getSessionUser: () => session,
    resolveProposalAccess: resolveAccess,
    pool: opts.pool as never,
    normalizeStanceValue,
    verifyAndUpsertStanceExplanation: verifyAndUpsertStanceExplanation as never,
    confirmExplanationForStance: confirmExplanationForStance as never,
    deleteStanceExplanation: deleteStanceExplanation as never,
    fetchImpl: opts.fetchImpl,
  });

  const adminHandler = createAdminStanceHandler({
    getSessionUser: () => session,
    isPrivilegedManualEditorHandle,
    normalizeHandle: (v) => String(v ?? "").trim().toLowerCase().replace(/^@+/, ""),
    normalizeStanceValue,
    resolveProposalAccess: resolveAccess,
    getProposalById: (id) => getProposalById(id),
    isFinalProposalStatus,
    pool: opts.pool as never,
    upsertStanceWithHistory: async (_client, args) => {
      opts.pool._stances.set(`${args.xUserId}:${args.proposalId}`, {
        x_user_id: args.xUserId,
        proposal_id: args.proposalId,
        stance: args.stance,
      });
      return {
        changed: true,
        row: {
          x_user_id: args.xUserId,
          handle: args.handle,
          stance: args.stance,
        },
      };
    },
  });

  app.put("/api/stance-explanation", explanationHandlers.putStanceExplanation);
  app.delete("/api/stance-explanation", explanationHandlers.deleteStanceExplanationHandler);
  app.post("/api/admin/stance", adminHandler);
  app.post("/api/admin/remove-user", (req, res) => {
    if (!session || !isPrivilegedManualEditorHandle(session.handle)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    res.json({ removed: true });
  });
  return app;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function oembedPayload(handle: string, tweetId: string, text: string) {
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

/** Shared provider mock: oEmbed first; optional X API when bearer path is exercised. */
function makeProviderFetch(opts?: { apiAuthorId?: string }) {
  const apiAuthorId = opts?.apiAuthorId ?? "111";
  return async (url: string | URL | Request) => {
    const u = String(url);
    assert.doesNotMatch(u, /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//);
    if (u.includes("publish.x.com/oembed") || u.includes("publish.twitter.com/oembed")) {
      const embedded = new URL(u).searchParams.get("url") || "";
      const id = embedded.split("/status/")[1]?.split(/[?#]/)[0] || "";
      if (id === "999") {
        return jsonResponse(200, oembedPayload("eve", "999", "other-author"));
      }
      if (id === "404") return new Response("{}", { status: 404 });
      if (id === "429") return new Response("{}", { status: 429 });
      if (id === "500") return new Response("{}", { status: 500 });
      return jsonResponse(200, oembedPayload("alice", id, `oembed-text-${id}`));
    }
    const id = u.split("/tweets/")[1]?.split("?")[0];
    if (id === "999") {
      return jsonResponse(200, { data: { id: "999", author_id: "222", text: "nope" } });
    }
    return jsonResponse(200, {
      data: {
        id,
        author_id: apiAuthorId,
        text: `api-text-${id}`,
        created_at: "2024-01-01T00:00:00.000Z",
      },
    });
  };
}

test("production handlers: unauthenticated explanation rejected", async () => {
  const pool = makeFakePool();
  const app = makeApp({ session: null, pool });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/stance-explanation`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal: "bip54", tweet_url: "https://x.com/a/status/1" }),
    });
    assert.equal(res.status, 401);
  });
});

test("production handlers: oEmbed ownership, isolation, confirm, delete (no bearer)", async () => {
  const snowflake = "18446744073709551615";
  const pool = makeFakePool({
    stances: [
      { x_user_id: "111", proposal_id: "bip54", stance: "against" },
      { x_user_id: "111", proposal_id: "bip460", stance: "approve" },
      { x_user_id: "111", proposal_id: "bip110", stance: "neutral" },
    ],
  });
  const prevBearer = process.env.X_BEARER_TOKEN;
  const prevTw = process.env.TWITTER_BEARER_TOKEN;
  delete process.env.X_BEARER_TOKEN;
  delete process.env.TWITTER_BEARER_TOKEN;

  try {
    const app = makeApp({
      session: { x_user_id: "111", handle: "alice" },
      pool,
      fetchImpl: makeProviderFetch(),
    });

    await withServer(app, async (base) => {
      const noStance = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal: "bip448",
          tweet_url: `https://x.com/alice/status/${snowflake}`,
        }),
      });
      assert.equal(noStance.status, 409);

      const wrongAuthor = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", tweet_url: "https://x.com/alice/status/999" }),
      });
      assert.equal(wrongAuthor.status, 403);

      const missing = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", tweet_url: "https://x.com/alice/status/404" }),
      });
      assert.equal(missing.status, 404);

      const rate = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", tweet_url: "https://x.com/alice/status/429" }),
      });
      assert.equal(rate.status, 503);

      const fail = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", tweet_url: "https://x.com/alice/status/500" }),
      });
      assert.equal(fail.status, 503);

      const save54 = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal: "bip54",
          tweet_url: `https://x.com/alice/status/${snowflake}?s=20`,
          tweet_text: "client-forged-text",
        }),
      });
      assert.equal(save54.status, 200);
      const body54 = await save54.json();
      assert.equal(body54.explanation.tweet_id, snowflake);
      assert.equal(body54.explanation.tweet_text, `oembed-text-${snowflake}`);
      assert.equal(body54.explanation.verification_method, "x_oembed_author_handle");
      assert.doesNotMatch(body54.explanation.tweet_text, /</);
      assert.equal(pool._explanations.get("111:bip54")?.verification_method, "x_oembed_author_handle");
      assert.equal(pool._explanations.get("111:bip54")?.author_x_user_id, null);

      const save460 = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal: "bip460",
          tweet_url: "https://x.com/alice/status/42",
        }),
      });
      assert.equal(save460.status, 200);

      pool._stances.set("111:bip54", { x_user_id: "111", proposal_id: "bip54", stance: "approve" });
      const confirm = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", confirm_existing: true }),
      });
      assert.equal(confirm.status, 200);
      const confirmed = await confirm.json();
      assert.equal(confirmed.explanation.stance_at_verification, "approve");
      assert.equal(confirmed.explanation.tweet_id, snowflake);

      const del54 = await fetch(`${base}/api/stance-explanation`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54" }),
      });
      assert.equal(del54.status, 200);
      assert.equal(pool._explanations.has("111:bip54"), false);
      assert.equal(pool._explanations.get("111:bip460")?.tweet_id, "42");

      const save110 = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal: "bip110",
          tweet_url: "https://x.com/alice/status/1101",
        }),
      });
      assert.equal(save110.status, 200);
      assert.equal(pool._stances.get("111:bip110")?.stance, "neutral");
    });
  } finally {
    if (prevBearer != null) process.env.X_BEARER_TOKEN = prevBearer;
    else delete process.env.X_BEARER_TOKEN;
    if (prevTw != null) process.env.TWITTER_BEARER_TOKEN = prevTw;
    else delete process.env.TWITTER_BEARER_TOKEN;
  }
});

test("optional bearer cross-check upgrades verification_method and rejects author_id mismatch", async () => {
  const pool = makeFakePool({
    stances: [{ x_user_id: "111", proposal_id: "bip54", stance: "against" }],
  });
  process.env.X_BEARER_TOKEN = "test-bearer";
  try {
    const okApp = makeApp({
      session: { x_user_id: "111", handle: "alice" },
      pool,
      fetchImpl: makeProviderFetch({ apiAuthorId: "111" }),
    });
    await withServer(okApp, async (base) => {
      const save = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal: "bip54",
          tweet_url: "https://x.com/alice/status/55",
          tweet_text: "forged",
        }),
      });
      assert.equal(save.status, 200);
      const body = await save.json();
      assert.equal(body.explanation.tweet_text, "api-text-55");
      assert.equal(body.explanation.verification_method, "x_api_author_id");
      assert.equal(pool._explanations.get("111:bip54")?.author_x_user_id, "111");
      assert.equal(pool._explanations.get("111:bip54")?.verification_method, "x_api_author_id");
    });

    const mismatchPool = makeFakePool({
      stances: [{ x_user_id: "111", proposal_id: "bip54", stance: "against" }],
    });
    const badApp = makeApp({
      session: { x_user_id: "111", handle: "alice" },
      pool: mismatchPool,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("oembed")) {
          return jsonResponse(200, oembedPayload("alice", "77", "handle-ok"));
        }
        return jsonResponse(200, { data: { id: "77", author_id: "999", text: "api" } });
      },
    });
    await withServer(badApp, async (base) => {
      const res = await fetch(`${base}/api/stance-explanation`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposal: "bip54", tweet_url: "https://x.com/alice/status/77" }),
      });
      assert.equal(res.status, 403);
      assert.equal(mismatchPool._explanations.size, 0);
    });
  } finally {
    delete process.env.X_BEARER_TOKEN;
  }
});

test("production verify path maps timeout/abort to temporary failure without writing", async () => {
  const pool = makeFakePool({
    stances: [{ x_user_id: "111", proposal_id: "bip54", stance: "against" }],
  });
  const prevBearer = process.env.X_BEARER_TOKEN;
  delete process.env.X_BEARER_TOKEN;
  try {
    const result = await verifyAndUpsertStanceExplanation(pool as never, {
      xUserId: "111",
      handle: "alice",
      proposalId: "bip54",
      tweetUrl: "https://x.com/alice/status/1",
      fetchImpl: async () => {
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 503);
      assert.equal(result.error, "verification_unavailable");
    }
    assert.equal(pool._explanations.size, 0);
  } finally {
    if (prevBearer != null) process.env.X_BEARER_TOKEN = prevBearer;
    else delete process.env.X_BEARER_TOKEN;
  }
});

test("production admin stance: final BIP-110 blocks any target; hampus_s is not admin", async () => {
  const pool = makeFakePool({
    community: [{ x_user_id: "9", handle: "alice", followers_count: 1 }],
  });
  const adminApp = makeApp({
    session: { x_user_id: "1", handle: "zndtoshi" },
    pool,
  });
  await withServer(adminApp, async (base) => {
    const freezeOther = await fetch(`${base}/api/admin/stance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "alice", stance: "against", proposal: "bip110" }),
    });
    assert.equal(freezeOther.status, 409);
    const body = await freezeOther.json();
    assert.equal(body.error, "proposal_stances_frozen");

    const okOngoing = await fetch(`${base}/api/admin/stance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "alice", stance: "approve", proposal: "bip54" }),
    });
    assert.equal(okOngoing.status, 200);
  });

  const previewApp = makeApp({
    session: { x_user_id: "77", handle: "hampus_s" },
    pool,
  });
  await withServer(previewApp, async (base) => {
    const denied = await fetch(`${base}/api/admin/stance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "alice", stance: "against", proposal: "bip54" }),
    });
    assert.equal(denied.status, 403);
    const removeDenied = await fetch(`${base}/api/admin/remove-user`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "alice" }),
    });
    assert.equal(removeDenied.status, 403);
  });
});

test("full-universe preview access is separate from admin privilege", () => {
  assert.equal(isFullUniversePreviewHandle("Hampus_S"), true);
  assert.equal(isFullUniversePreviewHandle("zndtoshi"), false);
  assert.equal(isPrivilegedManualEditorHandle("hampus_s"), false);
  assert.equal(canAccessAdminOnlyProposal("hampus_s"), true);
  assert.equal(canAccessAdminOnlyProposal("alice"), false);

  const previewMap = new Map([
    ["bip110", false],
    ["bip54", true],
    ["bip448", true],
    ["bip460", true],
  ]);
  assert.equal(
    resolveProposalAccess({
      rawProposal: "bip54",
      sessionHandle: "hampus_s",
      adminOnlyById: previewMap,
    }).allowed,
    true
  );
  assert.equal(
    resolveProposalAccess({
      rawProposal: "bip54",
      sessionHandle: "alice",
      adminOnlyById: previewMap,
    }).allowed,
    false
  );
  assert.equal(
    resolveProposalAccess({
      rawProposal: "bip54",
      sessionHandle: "zndtoshi",
      adminOnlyById: previewMap,
    }).allowed,
    true
  );
  assert.equal(
    resolveProposalAccess({
      rawProposal: "bip54",
      sessionHandle: "hampus_s",
      adminOnlyById: previewMap,
    }).isAdmin,
    false
  );
});
