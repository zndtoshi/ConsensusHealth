/**
 * "Name the Fork" easter-egg naming poll — separate from BIP proposal stances.
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  isPrivacySuppressed,
  loadPrivacySuppressionKeys,
} from "./privacySuppressions.js";
import { loadRemovedCommunityUserKeys } from "./communityPublicSurfaces.js";

export const NAME_THE_FORK_PATH = "/name-the-fork";
export const NAME_THE_FORK_ADVISORY_LOCK_KEY = 0x4e_54_46_4b; // "NTFK"
export const NAME_THE_FORK_MIGRATION_VERSION = "2026-08-name-the-fork-v1";
export const NAME_THE_FORK_MAX_CHARS = 14;
export const NTF_UNIQUE_NORMALIZED_KEY = "idx_ntf_candidates_normalized_key";
export const NTF_UNIQUE_ONE_CUSTOM_PER_USER = "idx_ntf_candidates_one_custom_per_user";

export const NAME_THE_FORK_SEEDS = [
  { id: "seed_bcashjr", displayName: "BcashJr", order: 0 },
  { id: "seed_bdash", displayName: "Bdash", order: 1 },
  { id: "seed_bitcoin110", displayName: "Bitcoin110", order: 2 },
] as const;

export type NameTheForkSeed = (typeof NAME_THE_FORK_SEEDS)[number];

export type NameNormalizeOk = {
  ok: true;
  displayName: string;
  normalizedKey: string;
  length: number;
};

export type NameNormalizeErr = {
  ok: false;
  error:
    | "empty"
    | "too_long"
    | "invalid_chars"
    | "url"
    | "handle"
    | "markup"
    | "separator"
    | "control";
};

export type NameNormalizeResult = NameNormalizeOk | NameNormalizeErr;

/** Count user-perceived characters (grapheme clusters). */
export function graphemeLength(text: string): number {
  const s = String(text ?? "");
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      return [...seg.segment(s)].length;
    } catch {
      /* fall through */
    }
  }
  return [...s].length;
}

/**
 * Trim, collapse internal whitespace, validate charset + length.
 * Server is authoritative; client mirrors for guidance.
 */
export function normalizeCandidateName(raw: unknown): NameNormalizeResult {
  let s = String(raw ?? "");
  if (/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/.test(s)) {
    return { ok: false, error: "control" };
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return { ok: false, error: "empty" };
  if (/https?:\/\//i.test(s) || /www\./i.test(s)) return { ok: false, error: "url" };
  if (s.includes("@")) return { ok: false, error: "handle" };
  if (/[<>&`]/.test(s) || /<\/?[a-z]/i.test(s)) return { ok: false, error: "markup" };
  if (/^[\s\-_]|[\s\-_]$/.test(s) || /[\s\-_]{2,}/.test(s)) return { ok: false, error: "separator" };
  // Letters/numbers from common scripts + single internal spaces/hyphens/underscores.
  if (!/^[\p{L}\p{N}]+(?:[ \-_][\p{L}\p{N}]+)*$/u.test(s)) {
    return { ok: false, error: "invalid_chars" };
  }
  const length = graphemeLength(s);
  if (length > NAME_THE_FORK_MAX_CHARS) return { ok: false, error: "too_long" };
  const normalizedKey = s.normalize("NFKC").toLocaleLowerCase("en-US");
  return { ok: true, displayName: s, normalizedKey, length };
}

export function isReservedSeedName(normalizedKey: string): boolean {
  const key = String(normalizedKey || "");
  for (const seed of NAME_THE_FORK_SEEDS) {
    const norm = normalizeCandidateName(seed.displayName);
    if (norm.ok && norm.normalizedKey === key) return true;
  }
  return false;
}

export async function ensureNameTheForkSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  console.log("[name-the-fork] migration started", { version: NAME_THE_FORK_MIGRATION_VERSION });
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [NAME_THE_FORK_ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS name_the_fork_candidates (
        id TEXT PRIMARY KEY,
        normalized_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_seed BOOLEAN NOT NULL DEFAULT FALSE,
        seed_order INTEGER NULL,
        proposer_x_user_id TEXT NULL REFERENCES community_users(x_user_id) ON DELETE SET NULL,
        proposer_handle TEXT NULL,
        hidden_at TIMESTAMPTZ NULL,
        hidden_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${NTF_UNIQUE_NORMALIZED_KEY}
       ON name_the_fork_candidates (normalized_key)`
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${NTF_UNIQUE_ONE_CUSTOM_PER_USER}
       ON name_the_fork_candidates (proposer_x_user_id)
       WHERE is_seed = FALSE AND proposer_x_user_id IS NOT NULL`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_ntf_candidates_visible
       ON name_the_fork_candidates (hidden_at NULLS FIRST, created_at)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS name_the_fork_votes (
        x_user_id TEXT PRIMARY KEY REFERENCES community_users(x_user_id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES name_the_fork_candidates(id) ON DELETE CASCADE,
        handle TEXT,
        display_name TEXT,
        avatar_url TEXT,
        avatar_path TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_ntf_votes_candidate ON name_the_fork_votes (candidate_id)`
    );

    await seedNameTheForkCandidates(client);

    await client.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
      [NAME_THE_FORK_MIGRATION_VERSION]
    );
    await client.query("COMMIT");
    console.log("[name-the-fork] migration complete");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function seedNameTheForkCandidates(client: Pool | PoolClient): Promise<void> {
  for (const seed of NAME_THE_FORK_SEEDS) {
    const norm = normalizeCandidateName(seed.displayName);
    if (!norm.ok) continue;
    await client.query(
      `
        INSERT INTO name_the_fork_candidates (
          id, normalized_key, display_name, is_seed, seed_order, created_at
        ) VALUES ($1, $2, $3, TRUE, $4, now())
        ON CONFLICT (id) DO UPDATE SET
          normalized_key = EXCLUDED.normalized_key,
          display_name = EXCLUDED.display_name,
          is_seed = TRUE,
          seed_order = EXCLUDED.seed_order
        WHERE name_the_fork_candidates.is_seed = TRUE
      `,
      [seed.id, norm.normalizedKey, seed.displayName, seed.order]
    );
  }
}

export type NameTheForkVoterPublic = {
  x_user_id: string;
  handle: string | null;
  name: string | null;
  avatar_url: string | null;
  avatar_path: string | null;
};

export type NameTheForkCandidatePublic = {
  id: string;
  display_name: string;
  is_seed: boolean;
  vote_count: number;
  percentage: number;
  rank: number;
  proposer_handle: string | null;
  voters: NameTheForkVoterPublic[];
};

export type NameTheForkPayload = {
  generated_at: string;
  title: string;
  subtitle: string;
  total_voters: number;
  candidates: NameTheForkCandidatePublic[];
  me: {
    authenticated: boolean;
    selected_candidate_id: string | null;
    has_custom_slot_used: boolean;
    can_moderate: boolean;
  } | null;
};

type VoteRow = {
  x_user_id: string;
  candidate_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  avatar_path: string | null;
};

type CandidateRow = {
  id: string;
  display_name: string;
  is_seed: boolean;
  seed_order: number | null;
  proposer_handle: string | null;
  created_at: Date | string;
  normalized_key: string;
  hidden_at: Date | string | null;
};

function compareCandidates(
  a: CandidateRow & { vote_count: number },
  b: CandidateRow & { vote_count: number }
): number {
  if (b.vote_count !== a.vote_count) return b.vote_count - a.vote_count;
  const aSeed = a.is_seed ? 1 : 0;
  const bSeed = b.is_seed ? 1 : 0;
  if (aSeed !== bSeed) return bSeed - aSeed; // seeds first on ties only when both same count — brief: seeded retain catalog order
  if (a.is_seed && b.is_seed) {
    return (a.seed_order ?? 0) - (b.seed_order ?? 0);
  }
  const aTime = new Date(a.created_at).getTime();
  const bTime = new Date(b.created_at).getTime();
  if (aTime !== bTime) return aTime - bTime;
  return String(a.normalized_key).localeCompare(String(b.normalized_key));
}

export async function buildNameTheForkPayload(
  pool: Pool,
  opts?: { viewerXUserId?: string | null; viewerHandle?: string | null; canModerate?: boolean }
): Promise<NameTheForkPayload> {
  const candRes = await pool.query(
    `
      SELECT id, display_name, is_seed, seed_order, proposer_handle, proposer_x_user_id,
             created_at, normalized_key, hidden_at
      FROM name_the_fork_candidates
      ORDER BY created_at ASC
    `
  );
  const candidates = candRes.rows as Array<
    CandidateRow & { proposer_x_user_id?: string | null }
  >;
  const visible = candidates.filter((c) => !c.hidden_at);

  const voteRes = await pool.query(
    `
      SELECT x_user_id, candidate_id, handle, display_name, avatar_url, avatar_path
      FROM name_the_fork_votes
    `
  );
  const votes = voteRes.rows as VoteRow[];
  const privacyKeys = await loadPrivacySuppressionKeys(pool);
  const removed = await loadRemovedCommunityUserKeys(pool);

  function isPubliclyHiddenIdentity(account: {
    x_user_id?: unknown;
    handle?: unknown;
  }): boolean {
    if (isPrivacySuppressed(account, privacyKeys)) return true;
    const id = String(account.x_user_id ?? "").trim();
    const handle = String(account.handle ?? "")
      .trim()
      .toLowerCase()
      .replace(/^@+/, "");
    if (id && removed.xUserIds.has(id)) return true;
    if (handle && removed.handles.has(handle)) return true;
    return false;
  }

  const visibleIds = new Set(visible.map((c) => c.id));
  const countingVotes = votes.filter(
    (v) => visibleIds.has(v.candidate_id) && !isPubliclyHiddenIdentity(v)
  );

  const countById = new Map<string, number>();
  const votersById = new Map<string, NameTheForkVoterPublic[]>();
  for (const c of visible) {
    countById.set(c.id, 0);
    votersById.set(c.id, []);
  }
  for (const v of countingVotes) {
    countById.set(v.candidate_id, (countById.get(v.candidate_id) || 0) + 1);
    const list = votersById.get(v.candidate_id) || [];
    list.push({
      x_user_id: String(v.x_user_id),
      handle: v.handle ? String(v.handle) : null,
      name: v.display_name ? String(v.display_name) : null,
      avatar_url: v.avatar_url ? String(v.avatar_url) : null,
      avatar_path: v.avatar_path ? String(v.avatar_path) : null,
    });
    votersById.set(v.candidate_id, list);
  }

  const totalVoters = countingVotes.length;
  const ranked = visible
    .map((c) => ({ ...c, vote_count: countById.get(c.id) || 0 }))
    .sort(compareCandidates);

  const publicCandidates: NameTheForkCandidatePublic[] = ranked.map((c, index) => {
    const vote_count = c.vote_count;
    const percentage =
      totalVoters > 0 ? Math.round((vote_count / totalVoters) * 1000) / 10 : 0;
    const voters = (votersById.get(c.id) || []).slice().sort((a, b) =>
      String(a.handle || a.x_user_id).localeCompare(String(b.handle || b.x_user_id))
    );
    const proposerSuppressed =
      !c.is_seed &&
      isPubliclyHiddenIdentity({
        x_user_id: c.proposer_x_user_id,
        handle: c.proposer_handle,
      });
    return {
      id: c.id,
      display_name: c.display_name,
      is_seed: Boolean(c.is_seed),
      vote_count,
      percentage,
      rank: index + 1,
      proposer_handle:
        c.is_seed || proposerSuppressed || !c.proposer_handle
          ? null
          : String(c.proposer_handle),
      voters,
    };
  });

  const viewerId = String(opts?.viewerXUserId || "").trim();
  let selected: string | null = null;
  let hasCustom = false;
  if (viewerId) {
    const mine = votes.find((v) => v.x_user_id === viewerId);
    if (mine && visibleIds.has(mine.candidate_id)) selected = mine.candidate_id;
    const customRes = await pool.query(
      `SELECT 1 FROM name_the_fork_candidates
       WHERE is_seed = FALSE AND proposer_x_user_id = $1 LIMIT 1`,
      [viewerId]
    );
    hasCustom = (customRes.rowCount ?? 0) > 0;
  }

  return {
    generated_at: new Date().toISOString(),
    title: "Name the Fork",
    subtitle:
      "An informal community naming poll for the new PoW fork — not an official protocol decision.",
    total_voters: totalVoters,
    candidates: publicCandidates,
    me: {
      authenticated: Boolean(viewerId),
      selected_candidate_id: selected,
      has_custom_slot_used: hasCustom,
      can_moderate: Boolean(opts?.canModerate),
    },
  };
}

export async function castNameTheForkVote(
  pool: Pool,
  opts: {
    xUserId: string;
    candidateId: string;
    handle?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
    avatarPath?: string | null;
  }
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const xUserId = String(opts.xUserId || "").trim();
  const candidateId = String(opts.candidateId || "").trim();
  if (!xUserId) return { ok: false, error: "not_logged_in", status: 401 };
  if (!candidateId) return { ok: false, error: "invalid_candidate", status: 400 };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cand = await client.query(
      `SELECT id, hidden_at FROM name_the_fork_candidates WHERE id = $1 FOR UPDATE`,
      [candidateId]
    );
    if (!cand.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "unknown_candidate", status: 404 };
    }
    if (cand.rows[0].hidden_at) {
      await client.query("ROLLBACK");
      return { ok: false, error: "candidate_hidden", status: 403 };
    }
    await client.query(
      `
        INSERT INTO name_the_fork_votes (
          x_user_id, candidate_id, handle, display_name, avatar_url, avatar_path, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (x_user_id) DO UPDATE SET
          candidate_id = EXCLUDED.candidate_id,
          handle = EXCLUDED.handle,
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          avatar_path = EXCLUDED.avatar_path,
          updated_at = now()
      `,
      [
        xUserId,
        candidateId,
        opts.handle ? String(opts.handle).toLowerCase().replace(/^@+/, "") : null,
        opts.name ? String(opts.name) : null,
        opts.avatarUrl ? String(opts.avatarUrl) : null,
        opts.avatarPath ? String(opts.avatarPath) : null,
      ]
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function removeNameTheForkVote(
  pool: Pool,
  xUserId: string
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const id = String(xUserId || "").trim();
  if (!id) return { ok: false, error: "not_logged_in", status: 401 };
  await pool.query(`DELETE FROM name_the_fork_votes WHERE x_user_id = $1`, [id]);
  return { ok: true };
}

export async function submitCustomNameTheForkCandidate(
  pool: Pool,
  opts: {
    xUserId: string;
    displayName: unknown;
    handle?: string | null;
    name?: string | null;
    avatarUrl?: string | null;
    avatarPath?: string | null;
  }
): Promise<
  | { ok: true; candidate_id: string }
  | { ok: false; error: string; status: number }
> {
  const xUserId = String(opts.xUserId || "").trim();
  if (!xUserId) return { ok: false, error: "not_logged_in", status: 401 };
  const norm = normalizeCandidateName(opts.displayName);
  if (!norm.ok) {
    const map: Record<string, string> = {
      empty: "invalid_name",
      too_long: "name_too_long",
      invalid_chars: "invalid_name",
      url: "invalid_name",
      handle: "invalid_name",
      markup: "invalid_name",
      separator: "invalid_name",
      control: "invalid_name",
    };
    return { ok: false, error: map[norm.error] || "invalid_name", status: 400 };
  }
  if (isReservedSeedName(norm.normalizedKey)) {
    return { ok: false, error: "reserved_name", status: 409 };
  }

  const handle = opts.handle
    ? String(opts.handle).toLowerCase().replace(/^@+/, "")
    : null;
  const candidateId = `custom_${randomUUID().replace(/-/g, "")}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT id FROM name_the_fork_candidates
       WHERE is_seed = FALSE AND proposer_x_user_id = $1 LIMIT 1`,
      [xUserId]
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "custom_already_submitted", status: 409 };
    }
    const dup = await client.query(
      `SELECT id FROM name_the_fork_candidates WHERE normalized_key = $1 LIMIT 1`,
      [norm.normalizedKey]
    );
    if (dup.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "duplicate_name", status: 409 };
    }
    await client.query(
      `
        INSERT INTO name_the_fork_candidates (
          id, normalized_key, display_name, is_seed, seed_order,
          proposer_x_user_id, proposer_handle, created_at
        ) VALUES ($1, $2, $3, FALSE, NULL, $4, $5, now())
      `,
      [candidateId, norm.normalizedKey, norm.displayName, xUserId, handle]
    );
    await client.query(
      `
        INSERT INTO name_the_fork_votes (
          x_user_id, candidate_id, handle, display_name, avatar_url, avatar_path, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (x_user_id) DO UPDATE SET
          candidate_id = EXCLUDED.candidate_id,
          handle = EXCLUDED.handle,
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          avatar_path = EXCLUDED.avatar_path,
          updated_at = now()
      `,
      [
        xUserId,
        candidateId,
        handle,
        opts.name ? String(opts.name) : null,
        opts.avatarUrl ? String(opts.avatarUrl) : null,
        opts.avatarPath ? String(opts.avatarPath) : null,
      ]
    );
    await client.query("COMMIT");
    return { ok: true, candidate_id: candidateId };
  } catch (err: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const code = (err as { code?: string; constraint?: string; message?: string })?.code;
    const constraint = String((err as { constraint?: string })?.constraint || "");
    const message = String((err as { message?: string })?.message || "");
    if (code === "23505") {
      if (
        constraint === NTF_UNIQUE_ONE_CUSTOM_PER_USER ||
        message.includes(NTF_UNIQUE_ONE_CUSTOM_PER_USER)
      ) {
        return { ok: false, error: "custom_already_submitted", status: 409 };
      }
      if (
        constraint === NTF_UNIQUE_NORMALIZED_KEY ||
        message.includes(NTF_UNIQUE_NORMALIZED_KEY)
      ) {
        return { ok: false, error: "duplicate_name", status: 409 };
      }
      return { ok: false, error: "duplicate_name", status: 409 };
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function hideNameTheForkCandidate(
  pool: Pool,
  opts: { candidateId: string; adminHandle: string }
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const candidateId = String(opts.candidateId || "").trim();
  if (!candidateId) return { ok: false, error: "invalid_candidate", status: 400 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `SELECT id, is_seed, hidden_at FROM name_the_fork_candidates WHERE id = $1 FOR UPDATE`,
      [candidateId]
    );
    if (!res.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "unknown_candidate", status: 404 };
    }
    if (res.rows[0].is_seed) {
      await client.query("ROLLBACK");
      return { ok: false, error: "cannot_hide_seed", status: 403 };
    }
    if (!res.rows[0].hidden_at) {
      await client.query(
        `UPDATE name_the_fork_candidates
         SET hidden_at = now(), hidden_by = $2
         WHERE id = $1 AND is_seed = FALSE`,
        [candidateId, String(opts.adminHandle || "zndtoshi")]
      );
    }
    // Drop votes so a concurrent cast that lost the row lock cannot leave a
    // newly accepted vote on a hidden candidate.
    await client.query(`DELETE FROM name_the_fork_votes WHERE candidate_id = $1`, [candidateId]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
