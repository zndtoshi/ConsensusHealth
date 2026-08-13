/**
 * Privacy-aware community merge + public read surfaces used by production routes.
 * Extracted so integration tests can mount the same handlers without importing index.ts.
 */

import fs from "node:fs";
import path from "node:path";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import type { Pool, PoolClient } from "pg";
import { createAccountDeletionHandler, type SessionUserForDeletion } from "./accountDeletion.js";
import {
  filterPrivacySuppressedAccounts,
  loadPrivacySuppressionKeys,
} from "./privacySuppressions.js";
import {
  DEFAULT_PROPOSAL_ID,
  getProposalById,
  isFinalProposalStatus,
  type ProposalId,
} from "./proposalCatalog.js";
import { resolveProposalAccessAsync } from "./proposals.js";
import { buildStanceCsvExport } from "./stanceCsvExport.js";
import { clampNewStancesLimit, queryNewStanceEvents } from "./newStances.js";
import { runStatsQueries } from "./proposalStats.js";
import {
  decodeStanceHistoryCursor,
  encodeStanceHistoryCursor,
  normalizeStanceValue,
  type ChangedByValue,
  type StanceValue,
} from "./stanceHistory.js";
import {
  coerceXUserIdKey,
  coerceXUserIdToDigitString,
  normalizeHandle,
  parseJsonPreservingSnowflakeIds,
} from "./xUserId.js";
import {
  filterOutRemovedCommunityUsers,
  normalizeRemovedHandle,
  normalizeRemovedXUserId,
} from "./removedCommunityUsers.js";
import {
  loadExplanationsForProposal,
  toPublicExplanation,
  type StanceExplanationPublicDto,
} from "./stanceExplanations.js";

export type CommunitySessionUser = SessionUserForDeletion & {
  name?: string | null;
  avatar_url?: string | null;
  followers_count?: number | null;
};

function hasStanceValue(value: unknown): boolean {
  return normalizeStanceValue(value) !== null;
}

function localNormalizeHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export function mergeCommunityUsers(
  seededRows: Record<string, unknown>[],
  dbRows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const toNonEmptyString = (value: unknown): string | null => {
    if (!isNonEmptyString(value)) return null;
    return value.trim();
  };
  const toNormalizedHandle = (value: unknown): string | null => {
    const normalized = normalizeHandle(value);
    return normalized || null;
  };
  const toFiniteFollowers = (value: unknown): number | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.trunc(n);
  };
  const toAccountCreatedAt = (row: Record<string, unknown>): string | null =>
    toNonEmptyString(row.account_created_at ?? row.accountCreatedAt);
  const toAvatarUrl = (row: Record<string, unknown>): string | null =>
    toNonEmptyString(
      row.avatar_url ?? row.avatarUrl ?? row.profile_image_url ?? row.profileImageUrl
    );
  const chooseString = (
    existing: string | null,
    incoming: string | null,
    source: "seeded" | "db"
  ): string | null => {
    if (source === "db") return incoming ?? existing;
    return existing ?? incoming;
  };
  const chooseFollowers = (
    existing: number | null,
    incoming: number | null,
    source: "seeded" | "db"
  ): number | null => {
    if (source === "db") {
      if (incoming != null && (incoming > 0 || existing == null || existing <= 0)) return incoming;
      return existing;
    }
    if (existing != null) return existing;
    return incoming;
  };

  const byHandle = new Map<string, Record<string, unknown>>();
  const byXid = new Map<string, Record<string, unknown>>();
  const merged: Record<string, unknown>[] = [];

  const upsert = (raw: Record<string, unknown>, source: "seeded" | "db"): void => {
    const incomingHandle = toNormalizedHandle(raw?.handle ?? raw?.username ?? raw?.screen_name);
    const incomingXUserId =
      coerceXUserIdToDigitString(raw?.x_user_id ?? raw?.xUserId) ??
      coerceXUserIdKey(raw?.x_user_id ?? raw?.xUserId);
    if (!incomingHandle && !incomingXUserId) return;

    let rec =
      (incomingXUserId && byXid.get(incomingXUserId)) ||
      (incomingHandle && byHandle.get(incomingHandle)) ||
      null;
    if (!rec) {
      rec = {};
      merged.push(rec);
    }

    for (const [key, value] of Object.entries(raw)) {
      const existing = rec[key];
      if (existing == null || (typeof existing === "string" && existing.trim() === "")) {
        rec[key] = value;
      }
    }

    const existingHandle = toNormalizedHandle(rec.handle ?? rec.username ?? rec.screen_name);
    const existingXUserId =
      coerceXUserIdToDigitString(rec.x_user_id ?? rec.xUserId) ??
      coerceXUserIdKey(rec.x_user_id ?? rec.xUserId);
    const bestHandle = chooseString(existingHandle, incomingHandle, source);
    const bestXUserId = chooseString(existingXUserId, incomingXUserId, source);
    if (bestHandle) rec.handle = bestHandle;
    if (bestXUserId) rec.x_user_id = bestXUserId;

    const existingName = toNonEmptyString(rec.name);
    const incomingName = toNonEmptyString(raw.name);
    const bestName = chooseString(existingName, incomingName, source);
    if (bestName) rec.name = bestName;

    const existingBio = toNonEmptyString(rec.bio);
    const incomingBio = toNonEmptyString(raw.bio ?? raw.bio_snippet ?? raw.description);
    const bestBio = chooseString(existingBio, incomingBio, source);
    if (bestBio) rec.bio = bestBio;

    const existingAvatarUrl = toAvatarUrl(rec);
    const incomingAvatarUrl = toAvatarUrl(raw);
    const bestAvatarUrl = chooseString(existingAvatarUrl, incomingAvatarUrl, source);
    if (bestAvatarUrl) rec.avatar_url = bestAvatarUrl;

    const existingFollowers = toFiniteFollowers(rec.followers_count);
    const incomingFollowers = toFiniteFollowers(raw.followers_count);
    const bestFollowers = chooseFollowers(existingFollowers, incomingFollowers, source);
    if (bestFollowers != null) rec.followers_count = bestFollowers;

    const existingAccountCreatedAt = toNonEmptyString(rec.account_created_at ?? rec.accountCreatedAt);
    const incomingAccountCreatedAt = toAccountCreatedAt(raw);
    const bestAccountCreatedAt = chooseString(
      existingAccountCreatedAt,
      incomingAccountCreatedAt,
      source
    );
    if (bestAccountCreatedAt) {
      rec.account_created_at = bestAccountCreatedAt;
      rec.accountCreatedAt = bestAccountCreatedAt;
    }

    const stanceNorm = normalizeStanceValue(
      source === "db" ? (raw.stance ?? rec.stance) : (rec.stance ?? raw.stance)
    );
    if (stanceNorm) rec.stance = stanceNorm;

    if (source === "db") {
      rec.accountCreatedAt = rec.accountCreatedAt ?? rec.account_created_at ?? null;
    }

    const finalHandle = toNormalizedHandle(rec.handle ?? rec.username ?? rec.screen_name);
    const finalXUserId =
      coerceXUserIdToDigitString(rec.x_user_id ?? rec.xUserId) ??
      coerceXUserIdKey(rec.x_user_id ?? rec.xUserId);
    if (finalXUserId) byXid.set(finalXUserId, rec);
    if (finalHandle) byHandle.set(finalHandle, rec);
  };

  for (const r of seededRows) upsert(r, "seeded");
  for (const r of dbRows) upsert(r, "db");
  return merged;
}

let seededAccountsCache: Record<string, unknown>[] | null = null;

/** Clear the in-process seed cache (tests). */
export function clearSeededAccountsCache(): void {
  seededAccountsCache = null;
}

export async function loadSeededAccountsForCommunity(
  candidates?: string[]
): Promise<Record<string, unknown>[]> {
  if (seededAccountsCache) return seededAccountsCache;
  const paths =
    candidates ??
    [
      path.resolve(process.cwd(), "public", "data", "accounts_stanced.json"),
      path.resolve(process.cwd(), "dist", "data", "accounts_stanced.json"),
    ];
  for (const p of paths) {
    try {
      const raw = await fs.promises.readFile(p, "utf-8");
      const data = parseJsonPreservingSnowflakeIds(raw);
      if (Array.isArray(data)) {
        seededAccountsCache = data as Record<string, unknown>[];
        return seededAccountsCache;
      }
    } catch {
      // try next
    }
  }
  return [];
}

export async function loadRemovedCommunityUserKeys(
  pool: Pool
): Promise<{ handles: Set<string>; xUserIds: Set<string> }> {
  const { rows } = await pool.query(`SELECT handle, x_user_id FROM removed_community_users`);
  const handles = new Set<string>();
  const xUserIds = new Set<string>();
  for (const row of rows as Array<{ handle?: unknown; x_user_id?: unknown }>) {
    const handle = normalizeRemovedHandle(row.handle);
    const xUserId = normalizeRemovedXUserId(row.x_user_id);
    if (handle) handles.add(handle);
    if (xUserId) xUserIds.add(xUserId);
  }
  return { handles, xUserIds };
}

export type LoadMergedCommunityDeps = {
  loadSeededAccounts?: () => Promise<Record<string, unknown>[]>;
  loadExplanations?: (
    pool: Pool,
    proposalId: string
  ) => Promise<Map<string, StanceExplanationPublicDto>>;
};

/**
 * Production BIP110 merge: DB stances + curated seed, with privacy tombstones applied
 * to seed rows only (re-registered self-reported DB stances remain visible).
 */
export async function loadMergedCommunityUsersWithStance(
  pool: Pool,
  proposalId: ProposalId = DEFAULT_PROPOSAL_ID,
  deps: LoadMergedCommunityDeps = {}
): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    `
    SELECT
      cu.x_user_id,
      cu.handle,
      cu.name,
      cu.avatar_url,
      cu.avatar_path,
      cu.followers_count,
      cu.bio,
      cu.account_created_at,
      cu.account_created_at AS "accountCreatedAt",
      ups.stance,
      (user_changed.x_user_id IS NOT NULL) AS "hasUserStanceChange"
    FROM user_proposal_stances ups
    INNER JOIN community_users cu ON cu.x_user_id = ups.x_user_id
    LEFT JOIN (
      SELECT DISTINCT x_user_id
      FROM user_proposal_stance_history
      WHERE changed_by = 'user' AND proposal_id = $1
    ) user_changed ON user_changed.x_user_id = cu.x_user_id
    WHERE ups.proposal_id = $1
    `,
    [proposalId]
  );
  const dbRows = (rows as Record<string, unknown>[]).filter((r) => hasStanceValue(r.stance));

  const loadExplanations = deps.loadExplanations ?? loadExplanationsForProposal;
  const explanations = await loadExplanations(pool, proposalId);
  const withExplanations: Record<string, unknown>[] = dbRows.map((r) => {
    const xUserId = String(r.x_user_id ?? "").trim();
    const publicExplanation = toPublicExplanation(explanations.get(xUserId) || null, r.stance);
    return {
      ...r,
      stance_explanation: publicExplanation,
    };
  });

  const privacyKeys = await loadPrivacySuppressionKeys(pool);
  const removed = await loadRemovedCommunityUserKeys(pool);

  if (proposalId !== DEFAULT_PROPOSAL_ID) {
    return filterOutRemovedCommunityUsers(withExplanations, removed);
  }

  const loadSeeded = deps.loadSeededAccounts ?? (() => loadSeededAccountsForCommunity());
  const seededRows = await loadSeeded();
  const seededVisible = filterPrivacySuppressedAccounts(seededRows, privacyKeys);
  const mergedRows = mergeCommunityUsers(seededVisible, withExplanations);
  const withStance = mergedRows
    .filter((r) => hasStanceValue(r.stance))
    .map((r) => {
      if (r.stance_explanation) return r;
      const xUserId = String(r.x_user_id ?? "").trim();
      const publicExplanation = toPublicExplanation(explanations.get(xUserId) || null, r.stance);
      return { ...r, stance_explanation: publicExplanation };
    });
  return filterOutRemovedCommunityUsers(withStance, removed);
}

export function mapStanceHistoryPublicRow(r: Record<string, unknown>) {
  const followersRaw = r.followers_count;
  let followers_count: number | null = null;
  if (followersRaw != null && followersRaw !== "") {
    const n = Number(followersRaw);
    if (Number.isFinite(n) && n >= 0) followers_count = Math.trunc(n);
  }
  const changedAt = new Date(String(r.changed_at)).toISOString();
  const id = Number(r.id);
  const previousRaw = r.previous_stance ?? r.from;
  const newRaw = r.new_stance ?? r.to;
  const previous_stance =
    previousRaw == null || previousRaw === "" ? null : String(previousRaw);
  const new_stance = String(newRaw ?? "");
  return {
    id: Number.isFinite(id) ? Math.trunc(id) : 0,
    handle: r.handle ? localNormalizeHandle(r.handle) : null,
    display_name: r.name != null && String(r.name).trim() ? String(r.name) : null,
    followers_count,
    previous_stance,
    new_stance,
    from: previous_stance,
    to: new_stance,
    changed_at: changedAt,
    changed_by: r.changed_by ? String(r.changed_by) : null,
  };
}

export async function queryRecentStanceHistoryPage(
  pool: Pool,
  args: {
    limit: number;
    cursor?: { changed_at: string; id: number } | null;
    proposalId?: ProposalId;
  }
): Promise<{
  items: ReturnType<typeof mapStanceHistoryPublicRow>[];
  next_cursor: string | null;
  has_more: boolean;
}> {
  const proposalId = args.proposalId || DEFAULT_PROPOSAL_ID;
  const limit = Math.max(1, Math.min(50, Math.trunc(args.limit) || 10));
  const params: Array<string | number> = [proposalId];
  let cursorSql = "";
  if (args.cursor) {
    params.push(args.cursor.changed_at);
    params.push(args.cursor.id);
    cursorSql = `AND (l.changed_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::int)`;
  }
  params.push(limit + 1);
  const { rows } = await pool.query(
    `
    WITH latest AS (
      SELECT
        sh.id,
        sh.x_user_id,
        sh.previous_stance,
        sh.new_stance,
        sh.changed_at,
        sh.changed_by,
        ROW_NUMBER() OVER (
          PARTITION BY sh.x_user_id
          ORDER BY sh.changed_at DESC, sh.id DESC
        ) AS rn
      FROM user_proposal_stance_history sh
      WHERE sh.proposal_id = $1
    )
    SELECT
      l.id,
      cu.handle,
      cu.name,
      cu.followers_count,
      l.previous_stance,
      l.new_stance,
      l.changed_at,
      l.changed_by
    FROM latest l
    LEFT JOIN community_users cu ON cu.x_user_id = l.x_user_id
    WHERE l.rn = 1
    ${cursorSql}
    ORDER BY l.changed_at DESC, l.id DESC
    LIMIT $${params.length}
    `,
    params
  );

  const has_more = rows.length > limit;
  const pageRows = has_more ? rows.slice(0, limit) : rows;
  const items = pageRows.map((r) => mapStanceHistoryPublicRow(r as Record<string, unknown>));
  const last = items[items.length - 1];
  const next_cursor =
    has_more && last
      ? encodeStanceHistoryCursor({ changed_at: last.changed_at, id: last.id })
      : null;

  return { items, next_cursor, has_more };
}

/** Minimal identity + proposal stance upsert used by the public surfaces stance writer. */
export async function upsertOngoingStance(
  client: PoolClient,
  args: {
    xUserId: string;
    handle: string;
    name?: string | null;
    avatarUrl?: string | null;
    followersCount?: number | null;
    stance: StanceValue;
    proposalId: ProposalId;
    changedBy?: ChangedByValue;
  }
): Promise<void> {
  const xUserId = String(args.xUserId || "").trim();
  const handle = localNormalizeHandle(args.handle);
  if (!xUserId || !handle) throw new Error("x_user_id and handle are required");

  await client.query(
    `
    INSERT INTO community_users (x_user_id, handle, name, avatar_url, followers_count)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (x_user_id) DO UPDATE SET
      handle = EXCLUDED.handle,
      name = COALESCE(EXCLUDED.name, community_users.name),
      avatar_url = COALESCE(EXCLUDED.avatar_url, community_users.avatar_url),
      followers_count = COALESCE(EXCLUDED.followers_count, community_users.followers_count),
      updated_at = now()
    `,
    [
      xUserId,
      handle,
      args.name ?? null,
      args.avatarUrl ?? null,
      args.followersCount ?? null,
    ]
  );

  const prev = await client.query(
    `SELECT stance FROM user_proposal_stances WHERE x_user_id = $1 AND proposal_id = $2`,
    [xUserId, args.proposalId]
  );
  const previous = normalizeStanceValue(prev.rows[0]?.stance ?? null);
  await client.query(
    `
    INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (x_user_id, proposal_id) DO UPDATE SET
      stance = EXCLUDED.stance,
      updated_at = now()
    `,
    [xUserId, args.proposalId, args.stance]
  );
  if (previous !== args.stance) {
    await client.query(
      `
      INSERT INTO user_proposal_stance_history
        (x_user_id, proposal_id, previous_stance, new_stance, changed_by)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [xUserId, args.proposalId, previous, args.stance, args.changedBy ?? "user"]
    );
  }
}

export type PrivacyPublicSurfacesDeps = {
  pool: Pool;
  getSessionUser: (req: Request) => CommunitySessionUser | null;
  avatarsDir?: string;
  invalidateStatsCache?: () => void;
  clearSessionCookie?: (res: Response) => void;
  loadSeededAccounts?: () => Promise<Record<string, unknown>[]>;
  loadExplanations?: LoadMergedCommunityDeps["loadExplanations"];
  selfStanceUpdatesEnabled?: boolean;
  /** Optional rate-limit middleware wrappers (production passes real limiters). */
  statsReadMiddleware?: RequestHandler;
};

const STANCE_CSV_EXPORT_ROUTES: Array<{ path: string; stance: StanceValue }> = [
  { path: "/stances/export-against.csv", stance: "against" },
  { path: "/stances/export-neutral.csv", stance: "neutral" },
  { path: "/stances/export-approve.csv", stance: "approve" },
];

/**
 * Mount production-equivalent privacy-sensitive public surfaces under an Express router
 * (paths relative to mount point, typically `/api`).
 */
export function createPrivacyPublicSurfacesRouter(deps: PrivacyPublicSurfacesDeps): Router {
  const router = express.Router();
  const pool = deps.pool;
  const statsMw = deps.statsReadMiddleware ?? ((_req, _res, next) => next());
  const statsCache = new Map<string, { expiresAt: number; payload: Record<string, unknown> }>();
  const invalidateStatsCache =
    deps.invalidateStatsCache ??
    (() => {
      statsCache.clear();
    });

  const loadMerged = (proposalId: ProposalId) =>
    loadMergedCommunityUsersWithStance(pool, proposalId, {
      loadSeededAccounts: deps.loadSeededAccounts,
      loadExplanations: deps.loadExplanations,
    });

  router.get("/community", async (req, res, next) => {
    try {
      const user = deps.getSessionUser(req);
      const access = await resolveProposalAccessAsync(pool, {
        rawProposal: req.query.proposal ?? req.query.bip,
        sessionHandle: user?.handle,
      });
      if (!access.known) {
        res.status(400).json({ error: "unknown_proposal" });
        return;
      }
      if (!access.allowed) {
        res.status(403).json({ error: "forbidden_proposal" });
        return;
      }
      const withStance = await loadMerged(access.proposalId);
      if (access.proposalId === DEFAULT_PROPOSAL_ID) {
        res.json(withStance);
        return;
      }
      res.json({ proposal_id: access.proposalId, accounts: withStance });
    } catch (err) {
      next(err);
    }
  });

  for (const route of STANCE_CSV_EXPORT_ROUTES) {
    router.get(route.path, async (req, res, next) => {
      try {
        const user = deps.getSessionUser(req);
        const access = await resolveProposalAccessAsync(pool, {
          rawProposal: req.query.proposal ?? req.query.bip,
          sessionHandle: user?.handle,
        });
        if (!access.known) {
          res.status(400).json({ error: "unknown_proposal" });
          return;
        }
        if (!access.allowed) {
          res.status(403).json({ error: "forbidden_proposal" });
          return;
        }
        const mergedRows = await loadMerged(access.proposalId);
        const { filename, content } = buildStanceCsvExport(mergedRows, route.stance);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(content);
      } catch (err) {
        next(err);
      }
    });
  }

  router.get("/stance-playback-sequence", statsMw, async (req, res, next) => {
    try {
      const user = deps.getSessionUser(req);
      const access = await resolveProposalAccessAsync(pool, {
        rawProposal: req.query.proposal ?? req.query.bip,
        sessionHandle: user?.handle,
      });
      if (!access.known) {
        res.status(400).json({ error: "unknown_proposal" });
        return;
      }
      if (!access.allowed) {
        res.status(403).json({ error: "forbidden_proposal" });
        return;
      }
      const proposalId = access.proposalId;
      const rowsRes = await pool.query(
        `
        WITH first_user AS (
          SELECT DISTINCT ON (sh.x_user_id)
            sh.x_user_id,
            sh.changed_at AS first_at,
            sh.new_stance
          FROM user_proposal_stance_history sh
          WHERE sh.changed_by = 'user'
            AND sh.proposal_id = $1
          ORDER BY sh.x_user_id ASC, sh.changed_at ASC
        )
        SELECT
          f.x_user_id,
          lower(trim(coalesce(cu.handle, ''))) AS handle,
          f.new_stance AS stance,
          f.first_at
        FROM first_user f
        INNER JOIN community_users cu ON cu.x_user_id = f.x_user_id
        WHERE trim(coalesce(cu.handle, '')) <> ''
        ORDER BY f.first_at ASC
        LIMIT 2000
        `,
        [proposalId]
      );
      const items = rowsRes.rows.map((r) => ({
        x_user_id: String(r.x_user_id ?? ""),
        handle: String(r.handle ?? "").trim(),
        stance: String(r.stance ?? "").trim(),
        changed_at: new Date(r.first_at).toISOString(),
      }));
      res.json({ proposal_id: proposalId, items });
    } catch (err) {
      next(err);
    }
  });

  router.get("/stances/new", statsMw, async (req, res, next) => {
    try {
      const user = deps.getSessionUser(req);
      const access = await resolveProposalAccessAsync(pool, {
        rawProposal: req.query.proposal ?? req.query.bip,
        sessionHandle: user?.handle,
      });
      if (!access.known) {
        res.status(400).json({ error: "unknown_proposal" });
        return;
      }
      if (!access.allowed) {
        res.status(403).json({ error: "forbidden_proposal" });
        return;
      }
      const afterRaw = String(req.query.afterEventId ?? "").trim();
      const limitRaw = String(req.query.limit ?? "").trim();
      const afterEventId =
        afterRaw && Number.isFinite(Number(afterRaw)) && Number(afterRaw) > 0
          ? Math.trunc(Number(afterRaw))
          : null;
      const limit = clampNewStancesLimit(limitRaw || 9);
      const items = await queryNewStanceEvents(pool, {
        afterEventId,
        limit,
        proposalId: access.proposalId,
      });
      res.json({
        generated_at: new Date().toISOString(),
        proposal_id: access.proposalId,
        items,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/stance-history", statsMw, async (req, res, next) => {
    try {
      const user = deps.getSessionUser(req);
      const access = await resolveProposalAccessAsync(pool, {
        rawProposal: req.query.proposal ?? req.query.bip,
        sessionHandle: user?.handle,
      });
      if (!access.known) {
        res.status(400).json({ error: "unknown_proposal" });
        return;
      }
      if (!access.allowed) {
        res.status(403).json({ error: "forbidden_proposal" });
        return;
      }
      const proposalId = access.proposalId;
      const limitRaw = String(req.query.limit ?? "").trim();
      const cursorRaw = String(req.query.cursor ?? "").trim();
      const wantsPage =
        Boolean(limitRaw || cursorRaw || String(req.query.page ?? "").trim() === "1");

      if (wantsPage) {
        const limit = Number(limitRaw || 10);
        const cursor = decodeStanceHistoryCursor(cursorRaw);
        if (cursorRaw && !cursor) {
          res.status(400).json({ error: "invalid_cursor" });
          return;
        }
        const page = await queryRecentStanceHistoryPage(pool, {
          limit: Number.isFinite(limit) ? limit : 10,
          cursor,
          proposalId,
        });
        res.json({
          generated_at: new Date().toISOString(),
          proposal_id: proposalId,
          items: page.items.map((item) => ({
            id: item.id,
            handle: item.handle,
            display_name: item.display_name,
            followers_count: item.followers_count,
            previous_stance: item.previous_stance,
            new_stance: item.new_stance,
            changed_at: item.changed_at,
            changed_by: item.changed_by,
          })),
          next_cursor: page.next_cursor,
          has_more: page.has_more,
        });
        return;
      }

      const xUserId = String(req.query.x_user_id ?? "").trim();
      const handle = normalizeHandle(req.query.handle);
      const where: string[] = [];
      const params: string[] = [];
      params.push(proposalId);
      where.push(`sh.proposal_id = $${params.length}`);
      if (xUserId) {
        params.push(xUserId);
        where.push(`sh.x_user_id = $${params.length}`);
      }
      if (handle) {
        params.push(handle);
        where.push(`lower(coalesce(cu.handle, '')) = $${params.length}`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const historyRes = await pool.query(
        `
        SELECT
          sh.id,
          sh.x_user_id,
          cu.handle,
          cu.name,
          cu.followers_count,
          sh.previous_stance,
          sh.new_stance,
          sh.changed_at,
          sh.changed_by
        FROM user_proposal_stance_history sh
        LEFT JOIN community_users cu ON cu.x_user_id = sh.x_user_id
        ${whereSql}
        ORDER BY sh.changed_at DESC, sh.id DESC
        LIMIT 500
        `,
        params
      );

      res.json({
        generated_at: new Date().toISOString(),
        proposal_id: proposalId,
        history: historyRes.rows.map((r) => {
          const mapped = mapStanceHistoryPublicRow(r as Record<string, unknown>);
          return {
            id: mapped.id,
            handle: mapped.handle,
            display_name: mapped.display_name,
            followers_count: mapped.followers_count,
            previous_stance: mapped.previous_stance,
            new_stance: mapped.new_stance,
            changed_at: mapped.changed_at,
            changed_by: mapped.changed_by,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/stats", statsMw, async (req, res, next) => {
    try {
      const user = deps.getSessionUser(req);
      const access = await resolveProposalAccessAsync(pool, {
        rawProposal: req.query.proposal ?? req.query.bip,
        sessionHandle: user?.handle,
      });
      if (!access.known) {
        res.status(400).json({ error: "unknown_proposal" });
        return;
      }
      if (!access.allowed) {
        res.status(403).json({ error: "forbidden_proposal" });
        return;
      }
      const proposalId = access.proposalId;
      const now = Date.now();
      const cachedEntry = statsCache.get(proposalId);
      if (cachedEntry && cachedEntry.expiresAt > now) {
        res.json({ ...cachedEntry.payload, _timing: { cache_hit: true } });
        return;
      }

      const toNum = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      const [aggRes, topRowsRes, , , , ,] = await runStatsQueries(pool, proposalId);
      const recentPage = await queryRecentStanceHistoryPage(pool, {
        limit: 10,
        cursor: null,
        proposalId,
      });

      const agg = aggRes.rows[0] || {};
      const counts = {
        against: toNum(agg.against_count),
        neutral: toNum(agg.neutral_count),
        approve: toNum(agg.approve_count),
      };
      const totalUsersWithStance = toNum(agg.total_users_with_stance);
      const denom = totalUsersWithStance || 1;
      const percentages = {
        against: Math.round((counts.against / denom) * 1000) / 10,
        neutral: Math.round((counts.neutral / denom) * 1000) / 10,
        approve: Math.round((counts.approve / denom) * 1000) / 10,
      };

      const topAccount: Record<
        string,
        { handle: string | null; followers_count: number | null }
      > = {
        against: { handle: null, followers_count: null },
        neutral: { handle: null, followers_count: null },
        approve: { handle: null, followers_count: null },
      };
      for (const r of topRowsRes.rows) {
        const stance = String(r.stance_norm || "");
        if (stance === "against" || stance === "neutral" || stance === "approve") {
          topAccount[stance] = {
            handle: r.handle ? String(r.handle) : null,
            followers_count: r.followers_count == null ? null : toNum(r.followers_count),
          };
        }
      }

      const payload = {
        generated_at: new Date().toISOString(),
        proposal_id: proposalId,
        counts,
        percentages,
        total_users_with_stance: totalUsersWithStance,
        top_account: topAccount,
        recent_changes: recentPage.items.map((item) => ({
          id: item.id,
          handle: item.handle,
          display_name: item.display_name,
          followers_count: item.followers_count,
          from: item.from,
          to: item.to,
          changed_at: item.changed_at,
        })),
      };
      statsCache.set(proposalId, { expiresAt: now + 15_000, payload });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/me/delete",
    express.json(),
    createAccountDeletionHandler({
      pool,
      getSessionUser: deps.getSessionUser,
      avatarsDir: deps.avatarsDir || path.resolve(process.cwd(), "public", "avatars"),
      invalidateStatsCache,
      clearSessionCookie:
        deps.clearSessionCookie ??
        ((res) => {
          res.clearCookie("consensushealth_session", { path: "/" });
        }),
    })
  );

  router.post("/stance", express.json(), async (req, res, next) => {
    try {
      if (deps.selfStanceUpdatesEnabled === false) {
        res.status(409).json({ error: "stance_updates_restricted" });
        return;
      }
      const user = deps.getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "not_logged_in" });
        return;
      }
      const requestedStance = normalizeStanceValue(req.body?.stance);
      if (!requestedStance) {
        res.status(400).json({ error: "invalid_stance" });
        return;
      }
      const access = await resolveProposalAccessAsync(pool, {
        rawProposal: req.body?.proposal ?? req.body?.proposal_id ?? req.query.proposal,
        sessionHandle: user.handle,
      });
      if (!access.known) {
        res.status(400).json({ error: "unknown_proposal" });
        return;
      }
      if (!access.allowed) {
        res.status(403).json({ error: "forbidden_proposal" });
        return;
      }
      const proposalMeta = getProposalById(access.proposalId);
      if (isFinalProposalStatus(proposalMeta?.status)) {
        res.status(409).json({
          error: "proposal_stances_frozen",
          message: "This proposal is a final locked snapshot. Positions can no longer be changed.",
        });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await upsertOngoingStance(client, {
          xUserId: user.x_user_id,
          handle: user.handle,
          name: user.name ?? null,
          avatarUrl: user.avatar_url ?? null,
          followersCount: user.followers_count ?? null,
          stance: requestedStance,
          proposalId: access.proposalId,
          changedBy: "user",
        });
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      invalidateStatsCache();
      res.json({ ok: true, proposal_id: access.proposalId, stance: requestedStance });
    } catch (err) {
      next(err);
    }
  });

  // Express error fallback for this router
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "internal_error";
    res.status(500).json({ error: "internal_error", message });
  });

  return router;
}
