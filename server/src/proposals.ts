/**
 * Consensus Universe schema migration + proposal helpers.
 *
 * Canonical stance data: user_proposal_stances / user_proposal_stance_history.
 * Legacy BIP110 community_users.stance / stance_history / stance_events are
 * compatibility mirrors only — written in the same transaction as canonical rows.
 */

import type { Pool, PoolClient } from "pg";
import {
  CONSENSUS_UNIVERSE_ADVISORY_LOCK_KEY,
  CONSENSUS_UNIVERSE_MIGRATION_VERSION,
  DEFAULT_PROPOSAL_ID,
  listEnabledProposalSeeds,
  resolveProposalId,
  tryResolveProposalId,
  type ProposalId,
  type PublicProposalDto,
  isValidThemeKey,
} from "./proposalCatalog.js";
import { isPrivilegedManualEditorHandle } from "./stanceHistory.js";

export {
  DEFAULT_PROPOSAL_ID,
  getProposalById,
  getProposalByBipNumber,
  listEnabledProposals,
  resolveProposalId,
  CONSENSUS_UNIVERSE_MIGRATION_VERSION,
  type ProposalId,
  type PublicProposalDto,
} from "./proposalCatalog.js";

export type ProposalAccess = {
  proposalId: ProposalId;
  isAdmin: boolean;
  allowed: boolean;
};

/** Resolve proposal from query/body; admin_only proposals require zndtoshi. */
export function resolveProposalAccess(opts: {
  rawProposal: unknown;
  sessionHandle: unknown;
  adminOnlyById?: Map<string, boolean>;
}): ProposalAccess {
  const proposalId = resolveProposalId(opts.rawProposal, DEFAULT_PROPOSAL_ID);
  const isAdmin = isPrivilegedManualEditorHandle(opts.sessionHandle);
  let adminOnly = proposalId !== DEFAULT_PROPOSAL_ID;
  if (opts.adminOnlyById?.has(proposalId)) {
    adminOnly = Boolean(opts.adminOnlyById.get(proposalId));
  } else {
    const seed = listEnabledProposalSeeds().find((p) => p.id === proposalId);
    if (seed) adminOnly = seed.adminOnly;
  }
  const allowed = !adminOnly || isAdmin;
  return { proposalId, isAdmin, allowed };
}

async function syncProposalCatalog(client: PoolClient): Promise<void> {
  for (const p of listEnabledProposalSeeds()) {
    await client.query(
      `
      INSERT INTO proposals (
        id, slug, bip_number, name, description, display_order, enabled,
        admin_only, theme_key, empty_message, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (id) DO UPDATE SET
        slug = EXCLUDED.slug,
        bip_number = EXCLUDED.bip_number,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        display_order = EXCLUDED.display_order,
        enabled = EXCLUDED.enabled,
        admin_only = EXCLUDED.admin_only,
        theme_key = EXCLUDED.theme_key,
        empty_message = EXCLUDED.empty_message,
        updated_at = now()
      `,
      [
        p.id,
        p.id,
        p.bipNumber,
        p.shortName,
        p.description,
        p.order,
        p.enabled,
        p.adminOnly,
        p.themeKey,
        p.emptyMessage,
      ]
    );
  }
  // Retire the superseded preview entry if an earlier galaxy build initialized it.
  await client.query(`UPDATE proposals SET enabled = FALSE, updated_at = now() WHERE id = 'bip119'`);
}

async function ensureSchemaObjects(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      bip_number INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      admin_only BOOLEAN NOT NULL DEFAULT TRUE,
      theme_key TEXT NOT NULL DEFAULT 'nebula-red',
      empty_message TEXT NOT NULL DEFAULT 'Be the first to map this consensus galaxy.',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`ALTER TABLE proposals ADD COLUMN IF NOT EXISTS admin_only BOOLEAN NOT NULL DEFAULT TRUE`);
  await client.query(`ALTER TABLE proposals ADD COLUMN IF NOT EXISTS theme_key TEXT NOT NULL DEFAULT 'nebula-red'`);
  await client.query(
    `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS empty_message TEXT NOT NULL DEFAULT 'Be the first to map this consensus galaxy.'`
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_proposal_stances (
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      stance TEXT NOT NULL CHECK (stance IN ('against','neutral','approve')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (x_user_id, proposal_id)
    );
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_user_proposal_stances_proposal ON user_proposal_stances (proposal_id)`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_user_proposal_stances_proposal_stance ON user_proposal_stances (proposal_id, stance)`
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_proposal_stance_history (
      id SERIAL PRIMARY KEY,
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      previous_stance TEXT CHECK (previous_stance IN ('against','neutral','approve') OR previous_stance IS NULL),
      new_stance TEXT NOT NULL CHECK (new_stance IN ('against','neutral','approve')),
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      changed_by TEXT NULL CHECK (changed_by IN ('user','admin','system','oauth','backfill') OR changed_by IS NULL),
      legacy_stance_history_id BIGINT NULL
    );
  `);
  await client.query(
    `ALTER TABLE user_proposal_stance_history ADD COLUMN IF NOT EXISTS legacy_stance_history_id BIGINT NULL`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ups_history_proposal_changed_at ON user_proposal_stance_history (proposal_id, changed_at DESC, id DESC)`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ups_history_user_proposal_changed_at ON user_proposal_stance_history (x_user_id, proposal_id, changed_at DESC, id DESC)`
  );
}

async function cleanupDuplicateProposalHistory(client: PoolClient): Promise<void> {
  await client.query(`
    DELETE FROM user_proposal_stance_history a
    USING user_proposal_stance_history b
    WHERE a.legacy_stance_history_id IS NOT NULL
      AND a.legacy_stance_history_id = b.legacy_stance_history_id
      AND a.id > b.id
  `);

  await client.query(`
    DELETE FROM user_proposal_stance_history a
    USING user_proposal_stance_history b
    WHERE a.proposal_id = b.proposal_id
      AND a.x_user_id = b.x_user_id
      AND a.new_stance = b.new_stance
      AND a.changed_at = b.changed_at
      AND a.previous_stance IS NOT DISTINCT FROM b.previous_stance
      AND a.changed_by IS NOT DISTINCT FROM b.changed_by
      AND a.legacy_stance_history_id IS NULL
      AND b.legacy_stance_history_id IS NULL
      AND a.id > b.id
  `);
}

async function ensureHistoryUniqueness(client: PoolClient): Promise<void> {
  await cleanupDuplicateProposalHistory(client);
  // PostgreSQL UNIQUE allows multiple NULLs, so runtime rows (NULL legacy id) are fine.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ups_history_legacy_id
    ON user_proposal_stance_history (legacy_stance_history_id)
  `);
}

async function backfillBip110Stances(client: PoolClient): Promise<void> {
  await client.query(
    `
    INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance, updated_at)
    SELECT
      cu.x_user_id,
      'bip110',
      CASE
        WHEN lower(coalesce(cu.stance, '')) = 'support' THEN 'approve'
        ELSE lower(cu.stance)
      END,
      COALESCE(cu.updated_at::timestamptz, now())
    FROM community_users cu
    WHERE cu.x_user_id IS NOT NULL
      AND (
        CASE
          WHEN lower(coalesce(cu.stance, '')) = 'support' THEN 'approve'
          WHEN lower(coalesce(cu.stance, '')) IN ('against', 'neutral', 'approve') THEN lower(cu.stance)
          ELSE NULL
        END
      ) IS NOT NULL
    ON CONFLICT (x_user_id, proposal_id) DO NOTHING
    `
  );
}

async function backfillBip110History(client: PoolClient): Promise<void> {
  await client.query(
    `
    INSERT INTO user_proposal_stance_history (
      x_user_id, proposal_id, previous_stance, new_stance, changed_at, changed_by, legacy_stance_history_id
    )
    SELECT
      sh.x_user_id,
      'bip110',
      CASE
        WHEN lower(coalesce(sh.previous_stance, '')) = 'support' THEN 'approve'
        WHEN lower(coalesce(sh.previous_stance, '')) IN ('against', 'neutral', 'approve') THEN lower(sh.previous_stance)
        ELSE NULL
      END,
      CASE
        WHEN lower(coalesce(sh.new_stance, '')) = 'support' THEN 'approve'
        WHEN lower(coalesce(sh.new_stance, '')) IN ('against', 'neutral', 'approve') THEN lower(sh.new_stance)
        ELSE NULL
      END,
      sh.changed_at,
      sh.changed_by,
      sh.id
    FROM stance_history sh
    WHERE sh.x_user_id IS NOT NULL
      AND lower(coalesce(sh.new_stance, '')) IN ('against', 'neutral', 'approve', 'support')
    ON CONFLICT (legacy_stance_history_id) DO NOTHING
    `
  );
}

/**
 * Production-safe proposal schema + BIP110 backfill.
 * Concurrent Render boots serialize via transaction-scoped advisory lock.
 */
export async function ensureProposalSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  console.log("[proposals-migrate] migration started", { version: CONSENSUS_UNIVERSE_MIGRATION_VERSION });
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [CONSENSUS_UNIVERSE_ADVISORY_LOCK_KEY]);
    console.log("[proposals-migrate] lock acquired");

    await ensureSchemaObjects(client);
    await syncProposalCatalog(client);

    const applied = await client.query(
      `SELECT 1 FROM schema_migrations WHERE version = $1 LIMIT 1`,
      [CONSENSUS_UNIVERSE_MIGRATION_VERSION]
    );
    const alreadyApplied = (applied.rowCount ?? 0) > 0;

    if (!alreadyApplied) {
      await backfillBip110Stances(client);
      await client.query(`
        UPDATE user_proposal_stance_history h
        SET legacy_stance_history_id = sh.id
        FROM stance_history sh
        WHERE h.legacy_stance_history_id IS NULL
          AND h.proposal_id = 'bip110'
          AND h.x_user_id = sh.x_user_id
          AND h.changed_at = sh.changed_at
          AND h.new_stance = CASE
            WHEN lower(coalesce(sh.new_stance, '')) = 'support' THEN 'approve'
            ELSE lower(sh.new_stance)
          END
          AND h.previous_stance IS NOT DISTINCT FROM CASE
            WHEN lower(coalesce(sh.previous_stance, '')) = 'support' THEN 'approve'
            WHEN lower(coalesce(sh.previous_stance, '')) IN ('against', 'neutral', 'approve') THEN lower(sh.previous_stance)
            ELSE NULL
          END
      `);
      await ensureHistoryUniqueness(client);
      await backfillBip110History(client);
      await client.query(
        `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
        [CONSENSUS_UNIVERSE_MIGRATION_VERSION]
      );
    } else {
      await ensureHistoryUniqueness(client);
    }

    await client.query("COMMIT");
    console.log("[proposals-migrate] migration completed", {
      version: CONSENSUS_UNIVERSE_MIGRATION_VERSION,
      already_applied: alreadyApplied,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    console.error("[proposals-migrate] migration failed", {
      version: CONSENSUS_UNIVERSE_MIGRATION_VERSION,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function loadAccessibleProposals(
  pool: Pool,
  sessionHandle: unknown
): Promise<{ isAdmin: boolean; items: PublicProposalDto[] }> {
  const isAdmin = isPrivilegedManualEditorHandle(sessionHandle);
  const { rows } = await pool.query(
    `
    SELECT
      id, slug, bip_number, name, description, display_order,
      admin_only, theme_key, empty_message
    FROM proposals
    WHERE enabled = TRUE
    ORDER BY display_order ASC, bip_number ASC
    `
  );
  const items: PublicProposalDto[] = [];
  for (const r of rows) {
    const adminOnly = Boolean(r.admin_only);
    if (adminOnly && !isAdmin) continue;
    const themeKey = isValidThemeKey(r.theme_key) ? r.theme_key : "nebula-red";
    items.push({
      id: String(r.id),
      slug: String(r.slug || r.id),
      bip_number: Number(r.bip_number) || 0,
      short_name: String(r.name || r.id),
      title: String(r.name || r.id),
      description: String(r.description || ""),
      order: Number(r.display_order) || 0,
      admin_only: adminOnly,
      theme_key: themeKey,
      empty_message: String(r.empty_message || "Be the first to map this consensus galaxy."),
    });
  }
  return { isAdmin, items };
}

export async function loadProposalAdminOnlyMap(pool: Pool): Promise<Map<string, boolean>> {
  const { rows } = await pool.query(`SELECT id, admin_only FROM proposals WHERE enabled = TRUE`);
  const map = new Map<string, boolean>();
  for (const r of rows) map.set(String(r.id), Boolean(r.admin_only));
  return map;
}

export async function resolveProposalAccessAsync(
  pool: Pool,
  opts: { rawProposal: unknown; sessionHandle: unknown }
): Promise<ProposalAccess & { known: boolean }> {
  const isAdmin = isPrivilegedManualEditorHandle(opts.sessionHandle);
  let adminOnlyById: Map<string, boolean>;
  try {
    adminOnlyById = await loadProposalAdminOnlyMap(pool);
  } catch {
    adminOnlyById = new Map(listEnabledProposalSeeds().map((p) => [p.id, p.adminOnly]));
  }

  const raw = String(opts.rawProposal ?? "").trim();
  if (!raw) {
    const adminOnly = Boolean(adminOnlyById.get(DEFAULT_PROPOSAL_ID) ?? false);
    return {
      proposalId: DEFAULT_PROPOSAL_ID,
      isAdmin,
      allowed: !adminOnly || isAdmin,
      known: true,
    };
  }

  const resolved = tryResolveProposalId(raw);
  if (!resolved || !adminOnlyById.has(resolved)) {
    return {
      proposalId: resolved || DEFAULT_PROPOSAL_ID,
      isAdmin,
      allowed: false,
      known: false,
    };
  }
  const adminOnly = Boolean(adminOnlyById.get(resolved));
  return {
    proposalId: resolved,
    isAdmin,
    allowed: !adminOnly || isAdmin,
    known: true,
  };
}
