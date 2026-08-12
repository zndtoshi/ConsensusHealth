/**
 * Proposal-scoped verified X-post stance explanations.
 */

import type { Pool, PoolClient } from "pg";
import { normalizeStanceValue, type StanceValue } from "./stanceHistory.js";
import {
  fetchXTweetById,
  getXAppBearerToken,
  isXApiTimeoutError,
} from "./xApiUsers.js";
import { parseStanceExplanationUrl } from "./stanceExplanationUrl.js";

export type StanceExplanationPublicDto = {
  proposal_id: string;
  tweet_id: string;
  canonical_url: string;
  tweet_text: string;
  author_handle: string;
  verified_at: string;
  stance_at_verification: StanceValue;
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
  return {
    proposal_id: proposalId,
    tweet_id: tweetId,
    canonical_url: url,
    tweet_text: text,
    author_handle: handle,
    verified_at: verifiedAt,
    stance_at_verification: stance,
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
      author_x_user_id TEXT NOT NULL,
      author_handle TEXT NOT NULL,
      stance_at_verification TEXT NOT NULL
        CHECK (stance_at_verification IN ('against','neutral','approve')),
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      unavailable_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (x_user_id, proposal_id),
      CONSTRAINT user_proposal_stance_explanations_stance_fk
        FOREIGN KEY (x_user_id, proposal_id)
        REFERENCES user_proposal_stances (x_user_id, proposal_id)
        ON DELETE CASCADE
    );
  `);
  await client.query(
    `ALTER TABLE user_proposal_stance_explanations ADD COLUMN IF NOT EXISTS unavailable_at TIMESTAMPTZ NULL`
  );
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
      author_handle, stance_at_verification, verified_at, unavailable_at
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
      e.author_handle, e.stance_at_verification, e.verified_at, e.unavailable_at,
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
    return { ok: false, status: 400, error: "invalid_tweet_url", message: parsed.error };
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
      message: "Choose a position before attaching an explanation.",
    };
  }

  let bearer: string;
  try {
    bearer = await getXAppBearerToken({ fetchImpl: args.fetchImpl });
  } catch (err) {
    if (isXApiTimeoutError(err)) {
      return { ok: false, status: 503, error: "verification_unavailable" };
    }
    return { ok: false, status: 503, error: "verification_unavailable" };
  }

  let tweet;
  try {
    tweet = await fetchXTweetById(bearer, parsed.value.tweetId, { fetchImpl: args.fetchImpl });
  } catch (err) {
    if (isXApiTimeoutError(err)) {
      return { ok: false, status: 503, error: "verification_unavailable" };
    }
    const status = Number((err as { status?: number })?.status || 0);
    if (status === 429) return { ok: false, status: 429, error: "verification_rate_limited" };
    return { ok: false, status: 502, error: "verification_failed" };
  }

  if (!tweet) {
    return { ok: false, status: 404, error: "tweet_unavailable" };
  }
  if (tweet.authorId !== String(args.xUserId).trim()) {
    return { ok: false, status: 403, error: "tweet_author_mismatch" };
  }

  const handle = String(args.handle)
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  const canonicalUrl = `https://x.com/${handle}/status/${tweet.id}`;

  const { rows } = await pool.query(
    `
    INSERT INTO user_proposal_stance_explanations (
      x_user_id, proposal_id, tweet_id, canonical_url, tweet_text,
      author_x_user_id, author_handle, stance_at_verification,
      verified_at, unavailable_at, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      now(), NULL, now(), now()
    )
    ON CONFLICT (x_user_id, proposal_id) DO UPDATE SET
      tweet_id = EXCLUDED.tweet_id,
      canonical_url = EXCLUDED.canonical_url,
      tweet_text = EXCLUDED.tweet_text,
      author_x_user_id = EXCLUDED.author_x_user_id,
      author_handle = EXCLUDED.author_handle,
      stance_at_verification = EXCLUDED.stance_at_verification,
      verified_at = now(),
      unavailable_at = NULL,
      updated_at = now()
    RETURNING
      proposal_id, tweet_id, canonical_url, tweet_text,
      author_handle, stance_at_verification, verified_at, unavailable_at
    `,
    [
      args.xUserId,
      args.proposalId,
      tweet.id,
      canonicalUrl,
      tweet.text,
      tweet.authorId,
      handle,
      stance,
    ]
  );

  const dto = mapPublicRow(rows[0] as Record<string, unknown>);
  if (!dto) return { ok: false, status: 502, error: "verification_failed" };
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
      author_handle, stance_at_verification, verified_at, unavailable_at
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
