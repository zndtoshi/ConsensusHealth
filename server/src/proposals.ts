/**
 * Server-side proposal helpers + DB bootstrap for multi-BIP galaxies.
 */

import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_PROPOSAL_ID,
  listEnabledProposals,
  resolveProposalId,
  type ProposalId,
} from "./proposalCatalog.js";
import { isPrivilegedManualEditorHandle } from "./stanceHistory.js";

export {
  DEFAULT_PROPOSAL_ID,
  getProposalById,
  getProposalByBipNumber,
  listEnabledProposals,
  resolveProposalId,
  type ProposalId,
} from "./proposalCatalog.js";

export type ProposalAccess = {
  proposalId: ProposalId;
  isAdmin: boolean;
  allowed: boolean;
};

/** Resolve proposal from query/body and enforce admin-only access for non-BIP110. */
export function resolveProposalAccess(opts: {
  rawProposal: unknown;
  sessionHandle: unknown;
}): ProposalAccess {
  const proposalId = resolveProposalId(opts.rawProposal, DEFAULT_PROPOSAL_ID);
  const isAdmin = isPrivilegedManualEditorHandle(opts.sessionHandle);
  const allowed = proposalId === DEFAULT_PROPOSAL_ID || isAdmin;
  return { proposalId, isAdmin, allowed };
}

export async function ensureProposalSchema(client: Pool | PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      bip_number INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

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
    `CREATE INDEX IF NOT EXISTS idx_user_proposal_stances_proposal ON user_proposal_stances (proposal_id);`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_user_proposal_stances_proposal_stance ON user_proposal_stances (proposal_id, stance);`
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_proposal_stance_history (
      id SERIAL PRIMARY KEY,
      x_user_id TEXT NOT NULL REFERENCES community_users(x_user_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      previous_stance TEXT CHECK (previous_stance IN ('against','neutral','approve') OR previous_stance IS NULL),
      new_stance TEXT NOT NULL CHECK (new_stance IN ('against','neutral','approve')),
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      changed_by TEXT NULL CHECK (changed_by IN ('user','admin','system','oauth','backfill') OR changed_by IS NULL)
    );
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ups_history_proposal_changed_at ON user_proposal_stance_history (proposal_id, changed_at DESC, id DESC);`
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_ups_history_user_proposal_changed_at ON user_proposal_stance_history (x_user_id, proposal_id, changed_at DESC, id DESC);`
  );

  for (const p of listEnabledProposals()) {
    await client.query(
      `
      INSERT INTO proposals (id, slug, bip_number, name, description, display_order, enabled, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (id) DO UPDATE SET
        slug = EXCLUDED.slug,
        bip_number = EXCLUDED.bip_number,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        display_order = EXCLUDED.display_order,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      `,
      [p.id, p.id, p.bipNumber, p.shortName, p.description, p.order, p.enabled]
    );
  }

  // Idempotent BIP110 backfill from legacy global stance column.
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

  // Idempotent BIP110 history backfill from legacy stance_history.
  await client.query(
    `
    INSERT INTO user_proposal_stance_history (
      x_user_id, proposal_id, previous_stance, new_stance, changed_at, changed_by
    )
    SELECT
      sh.x_user_id,
      'bip110',
      sh.previous_stance,
      sh.new_stance,
      sh.changed_at,
      sh.changed_by
    FROM stance_history sh
    WHERE sh.x_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM user_proposal_stance_history h
        WHERE h.x_user_id = sh.x_user_id
          AND h.proposal_id = 'bip110'
          AND h.changed_at = sh.changed_at
          AND h.new_stance = sh.new_stance
          AND h.previous_stance IS NOT DISTINCT FROM sh.previous_stance
      )
    `
  );
}
