/**
 * Proposal-scoped verified X-post stance explanations.
 *
 * Primary verification: official unauthenticated oEmbed (handle ownership).
 * Optional stronger check: X API v2 author_id when X_BEARER_TOKEN is configured.
 */

import type { Pool, PoolClient } from "pg";
import { normalizeStanceValue, type StanceValue } from "./stanceHistory.js";
import {
  fetchXTweetById,
} from "./xApiUsers.js";
import { parseStanceExplanationUrl } from "./stanceExplanationUrl.js";
import { verifyPublicPostViaOEmbed } from "./xOEmbed.js";

export type VerificationMethod = "x_api_author_id" | "x_oembed_author_handle";

export const STANCE_EXPLANATION_USER_MESSAGES = {
  invalid_tweet_url: "Enter a direct link to one of your X posts.",
  stance_required: "Choose a position before attaching an explanation.",
  verification_unavailable:
    "X verification is temporarily unavailable. Your explanation was not changed; please try again shortly.",
  verification_failed: "We could not verify this X post right now. Please try again shortly.",
  verification_rate_limited: "X verification is temporarily rate-limited. Please wait a moment and try again.",
  tweet_unavailable: "This X post could not be found or is not publicly accessible.",
  tweet_author_mismatch: "This post was not published by your connected X account.",
} as const;

type VerifyLogReason =
  | "invalid_tweet_url"
  | "stance_required"
  | "tweet_unavailable"
  | "tweet_author_mismatch"
  | "oembed_unavailable"
  | "oembed_malformed"
  | "oembed_author_mismatch"
  | "oembed_text_missing"
  | "author_id_crosscheck_failed"
  | "author_id_crosscheck_ok"
  | "timeout"
  | "verification_failed"
  | "verification_rate_limited"
  | "unauthorized";

function logVerifyIssue(opts: {
  reason: VerifyLogReason;
  proposalId: string;
  xUserId: string;
  tweetId?: string;
}) {
  // Operator-only diagnostics: never log tokens, cookies, or provider payloads.
  console.warn("[stance-explanation-verify]", {
    reason: opts.reason,
    proposal_id: opts.proposalId,
    x_user_id: opts.xUserId,
    ...(opts.tweetId ? { tweet_id: opts.tweetId } : {}),
  });
}

function configuredBearerToken(): string {
  return (process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || "").trim();
}

export type StanceExplanationPublicDto = {
  proposal_id: string;
  tweet_id: string;
  canonical_url: string;
  tweet_text: string;
  author_handle: string;
  verified_at: string;
  stance_at_verification: StanceValue;
  verification_method?: VerificationMethod | null;
};

export type StanceExplanationOwnerDto = StanceExplanationPublicDto & {
  matches_current_stance: boolean;
};

function mapPublicRow(r: Record<string, unknown>): StanceExplanationPublicDto | null {
  const tweetId = String(r.tweet_id ?? "").trim();
  const url = String(r.canonical_url ?? "").trim();
  const text = String(r.tweet_text ?? "");
  const handle = String(r.author_handle ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  const stance = normalizeStanceValue(r.stance_at_verification);
  const proposalId = String(r.proposal_id ?? "").trim();
  if (!tweetId || !url || !handle || !stance || !proposalId) return null;
  if (r.unavailable_at) return null;
  const verifiedAt = new Date(String(r.verified_at || r.updated_at || Date.now())).toISOString();
  const methodRaw = String(r.verification_method ?? "").trim();
  const verification_method: VerificationMethod | null =
    methodRaw === "x_api_author_id" || methodRaw === "x_oembed_author_handle" ? methodRaw : null;
  return {
    proposal_id: proposalId,
    tweet_id: tweetId,
    canonical_url: url,
    tweet_text: text,
    author_handle: handle,
    verified_at: verifiedAt,
    stance_at_verification: stance,
    verification_method,
  };
}

/** Public DTO only when explanation stance matches the account's current stance. */
export function toPublicExplanation(
  explanation: StanceExplanationPublicDto | null | undefined,
  currentStance: unknown
): StanceExplanationPublicDto | null {
  if (!explanation) return null;
  const cur = normalizeStanceValue(currentStance);
  if (!cur || cur !== explanation.stance_at_verification) return null;
  return explanation;
}

export function snippetExplanationText(text: unknown, maxChars = 160): string {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export async function ensureStanceExplanationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_proposal_stance_explanations (
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      tweet_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      tweet_text TEXT NOT NULL,
      -- Stable X author_id from API only; NULL when verification_method is handle-only oEmbed.
      author_x_user_id TEXT NULL,
      author_handle TEXT NOT NULL,
      stance_at_verification TEXT NOT NULL
        CHECK (stance_at_verification IN ('against','neutral','approve')),
      verification_method TEXT NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      unavailable_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (x_user_id, proposal_id),
      CONSTRAINT user_proposal_stance_explanations_stance_fk
        FOREIGN KEY (x_user_id, proposal_id)
        REFERENCES user_proposal_stances (x_user_id, proposal_id)
        ON DELETE CASCADE,
      CONSTRAINT stance_explanations_verification_coherence CHECK (
        verification_method IS NULL
        OR (
          verification_method = 'x_api_author_id'
          AND author_x_user_id IS NOT NULL
          AND btrim(author_x_user_id) <> ''
        )
        OR (
          verification_method = 'x_oembed_author_handle'
          AND author_x_user_id IS NULL
        )
      )
    );
  `);
  await client.query(
    `ALTER TABLE user_proposal_stance_explanations ADD COLUMN IF NOT EXISTS unavailable_at TIMESTAMPTZ NULL`
  );
  await client.query(
    `ALTER TABLE user_proposal_stance_explanations ADD COLUMN IF NOT EXISTS verification_method TEXT NULL`
  );
  // author_x_user_id is the verified API author_id only — nullable for oEmbed-only rows.
  await client.query(
    `ALTER TABLE user_proposal_stance_explanations ALTER COLUMN author_x_user_id DROP NOT NULL`
  );
  // Legacy API-verified rows (author id present, method unset) → x_api_author_id.
  await client.query(`
    UPDATE user_proposal_stance_explanations
    SET verification_method = 'x_api_author_id'
    WHERE verification_method IS NULL
      AND author_x_user_id IS NOT NULL
      AND btrim(author_x_user_id) <> ''
  `);
  // oEmbed-only rows must not keep a session/forged author_x_user_id.
  await client.query(`
    UPDATE user_proposal_stance_explanations
    SET author_x_user_id = NULL
    WHERE verification_method = 'x_oembed_author_handle'
      AND author_x_user_id IS NOT NULL
  `);
  // Replace older method-only checks with coherence between method and author_x_user_id.
  await client.query(`
    ALTER TABLE user_proposal_stance_explanations
      DROP CONSTRAINT IF EXISTS user_proposal_stance_explanations_verification_method_check
  `);
  await client.query(`
    ALTER TABLE user_proposal_stance_explanations
      DROP CONSTRAINT IF EXISTS stance_explanations_verification_coherence
  `);
  await client.query(`
    ALTER TABLE user_proposal_stance_explanations
      ADD CONSTRAINT stance_explanations_verification_coherence CHECK (
        verification_method IS NULL
        OR (
          verification_method = 'x_api_author_id'
          AND author_x_user_id IS NOT NULL
          AND btrim(author_x_user_id) <> ''
        )
        OR (
          verification_method = 'x_oembed_author_handle'
          AND author_x_user_id IS NULL
        )
      )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_stance_explanations_proposal
     ON user_proposal_stance_explanations (proposal_id)`
  );
}

export async function loadExplanationsForProposal(
  pool: Pool,
  proposalId: string
): Promise<Map<string, StanceExplanationPublicDto>> {
  const { rows } = await pool.query(
    `
    SELECT
      x_user_id, proposal_id, tweet_id, canonical_url, tweet_text,
      author_handle, stance_at_verification, verification_method,
      verified_at, unavailable_at
    FROM user_proposal_stance_explanations
    WHERE proposal_id = $1
    `,
    [proposalId]
  );
  const map = new Map<string, StanceExplanationPublicDto>();
  for (const r of rows) {
    const dto = mapPublicRow(r as Record<string, unknown>);
    if (!dto) continue;
    map.set(String((r as { x_user_id: string }).x_user_id), dto);
  }
  return map;
}

export async function loadExplanationsForUser(
  pool: Pool,
  xUserId: string
): Promise<Record<string, StanceExplanationOwnerDto | null>> {
  const { rows } = await pool.query(
    `
    SELECT
      e.proposal_id, e.tweet_id, e.canonical_url, e.tweet_text,
      e.author_handle, e.stance_at_verification, e.verification_method,
      e.verified_at, e.unavailable_at,
      ups.stance AS current_stance
    FROM user_proposal_stance_explanations e
    LEFT JOIN user_proposal_stances ups
      ON ups.x_user_id = e.x_user_id AND ups.proposal_id = e.proposal_id
    WHERE e.x_user_id = $1
    `,
    [xUserId]
  );
  const out: Record<string, StanceExplanationOwnerDto | null> = {};
  for (const r of rows) {
    const dto = mapPublicRow(r as Record<string, unknown>);
    if (!dto) {
      out[String(r.proposal_id)] = null;
      continue;
    }
    const current = normalizeStanceValue(r.current_stance);
    out[dto.proposal_id] = {
      ...dto,
      matches_current_stance: Boolean(current && current === dto.stance_at_verification),
    };
  }
  return out;
}

export type VerifyAndUpsertResult =
  | { ok: true; explanation: StanceExplanationPublicDto }
  | {
      ok: false;
      status: number;
      error: string;
      message?: string;
    };

export async function verifyAndUpsertStanceExplanation(
  pool: Pool,
  args: {
    xUserId: string;
    handle: string;
    proposalId: string;
    tweetUrl: unknown;
    fetchImpl?: typeof fetch;
  }
): Promise<VerifyAndUpsertResult> {
  const parsed = parseStanceExplanationUrl(args.tweetUrl, args.handle);
  if (!parsed.ok) {
    logVerifyIssue({
      reason: "invalid_tweet_url",
      proposalId: args.proposalId,
      xUserId: args.xUserId,
    });
    return {
      ok: false,
      status: 400,
      error: "invalid_tweet_url",
      message: STANCE_EXPLANATION_USER_MESSAGES.invalid_tweet_url,
    };
  }

  const stanceRes = await pool.query(
    `SELECT stance FROM user_proposal_stances WHERE x_user_id = $1 AND proposal_id = $2 LIMIT 1`,
    [args.xUserId, args.proposalId]
  );
  const stance = normalizeStanceValue(stanceRes.rows[0]?.stance);
  if (!stance) {
    return {
      ok: false,
      status: 409,
      error: "stance_required",
      message: STANCE_EXPLANATION_USER_MESSAGES.stance_required,
    };
  }

  const sessionHandle = String(args.handle)
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  // Always use the authenticated session handle in the canonical URL we store and
  // send to oEmbed — never trust a mismatched path username beyond the parser gate.
  const canonicalUrl = `https://x.com/${sessionHandle}/status/${parsed.value.tweetId}`;

  const oembed = await verifyPublicPostViaOEmbed({
    canonicalPostUrl: canonicalUrl,
    expectedTweetId: parsed.value.tweetId,
    expectedHandle: sessionHandle,
    fetchImpl: args.fetchImpl,
  });

  if (!oembed.ok) {
    logVerifyIssue({
      reason: oembed.reason,
      proposalId: args.proposalId,
      xUserId: args.xUserId,
      tweetId: parsed.value.tweetId,
    });
    if (oembed.reason === "oembed_author_mismatch") {
      return {
        ok: false,
        status: 403,
        error: "tweet_author_mismatch",
        message: STANCE_EXPLANATION_USER_MESSAGES.tweet_author_mismatch,
      };
    }
    if (oembed.reason === "tweet_unavailable") {
      return {
        ok: false,
        status: 404,
        error: "tweet_unavailable",
        message: STANCE_EXPLANATION_USER_MESSAGES.tweet_unavailable,
      };
    }
    if (oembed.reason === "timeout" || oembed.reason === "oembed_unavailable") {
      return {
        ok: false,
        status: 503,
        error: "verification_unavailable",
        message: STANCE_EXPLANATION_USER_MESSAGES.verification_unavailable,
      };
    }
    return {
      ok: false,
      status: 502,
      error: "verification_failed",
      message: STANCE_EXPLANATION_USER_MESSAGES.verification_failed,
    };
  }

  let tweetText = oembed.tweetText;
  // author_x_user_id means verified API author_id only — never the session id for oEmbed-only.
  let authorXUserId: string | null = null;
  let verificationMethod: VerificationMethod = "x_oembed_author_handle";
  let tweetId = oembed.tweetId;

  // Optional stronger stable-ID cross-check when an explicit bearer token is configured.
  // Missing/invalid bearer must never block a successful oEmbed verification.
  const bearer = configuredBearerToken();
  if (bearer) {
    try {
      const apiTweet = await fetchXTweetById(bearer, parsed.value.tweetId, {
        fetchImpl: args.fetchImpl,
      });
      if (!apiTweet) {
        logVerifyIssue({
          reason: "author_id_crosscheck_failed",
          proposalId: args.proposalId,
          xUserId: args.xUserId,
          tweetId: parsed.value.tweetId,
        });
      } else if (apiTweet.authorId !== String(args.xUserId).trim()) {
        logVerifyIssue({
          reason: "tweet_author_mismatch",
          proposalId: args.proposalId,
          xUserId: args.xUserId,
          tweetId: apiTweet.id,
        });
        return {
          ok: false,
          status: 403,
          error: "tweet_author_mismatch",
          message: STANCE_EXPLANATION_USER_MESSAGES.tweet_author_mismatch,
        };
      } else {
        tweetText = apiTweet.text || tweetText;
        authorXUserId = apiTweet.authorId;
        tweetId = apiTweet.id;
        verificationMethod = "x_api_author_id";
        logVerifyIssue({
          reason: "author_id_crosscheck_ok",
          proposalId: args.proposalId,
          xUserId: args.xUserId,
          tweetId: apiTweet.id,
        });
      }
    } catch {
      // Timeout / provider failure on optional API: keep handle-verified oEmbed result.
      logVerifyIssue({
        reason: "author_id_crosscheck_failed",
        proposalId: args.proposalId,
        xUserId: args.xUserId,
        tweetId: parsed.value.tweetId,
      });
    }
  }

  const storeUrl = `https://x.com/${oembed.authorHandle}/status/${tweetId}`;

  const { rows } = await pool.query(
    `
    INSERT INTO user_proposal_stance_explanations (
      x_user_id, proposal_id, tweet_id, canonical_url, tweet_text,
      author_x_user_id, author_handle, stance_at_verification, verification_method,
      verified_at, unavailable_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      now(), NULL, now(), now()
    )
    ON CONFLICT (x_user_id, proposal_id) DO UPDATE SET
      tweet_id = EXCLUDED.tweet_id,
      canonical_url = EXCLUDED.canonical_url,
      tweet_text = EXCLUDED.tweet_text,
      author_x_user_id = EXCLUDED.author_x_user_id,
      author_handle = EXCLUDED.author_handle,
      stance_at_verification = EXCLUDED.stance_at_verification,
      verification_method = EXCLUDED.verification_method,
      verified_at = now(),
      unavailable_at = NULL,
      updated_at = now()
    RETURNING
      proposal_id, tweet_id, canonical_url, tweet_text,
      author_handle, stance_at_verification, verification_method,
      verified_at, unavailable_at
    `,
    [
      args.xUserId,
      args.proposalId,
      tweetId,
      storeUrl,
      tweetText,
      authorXUserId,
      oembed.authorHandle,
      stance,
      verificationMethod,
    ]
  );

  const dto = mapPublicRow(rows[0] as Record<string, unknown>);
  if (!dto) {
    return {
      ok: false,
      status: 502,
      error: "verification_failed",
      message: STANCE_EXPLANATION_USER_MESSAGES.verification_failed,
    };
  }
  return { ok: true, explanation: dto };
}

export async function confirmExplanationForStance(
  pool: Pool,
  args: { xUserId: string; proposalId: string; stance: StanceValue }
): Promise<StanceExplanationPublicDto | null> {
  const { rows } = await pool.query(
    `
    UPDATE user_proposal_stance_explanations
    SET stance_at_verification = $3, updated_at = now()
    WHERE x_user_id = $1 AND proposal_id = $2 AND unavailable_at IS NULL
    RETURNING
      proposal_id, tweet_id, canonical_url, tweet_text,
      author_handle, stance_at_verification, verification_method,
      verified_at, unavailable_at
    `,
    [args.xUserId, args.proposalId, args.stance]
  );
  return mapPublicRow((rows[0] || null) as Record<string, unknown>);
}

export async function deleteStanceExplanation(
  pool: Pool,
  args: { xUserId: string; proposalId: string }
): Promise<void> {
  await pool.query(
    `DELETE FROM user_proposal_stance_explanations WHERE x_user_id = $1 AND proposal_id = $2`,
    [args.xUserId, args.proposalId]
  );
}
