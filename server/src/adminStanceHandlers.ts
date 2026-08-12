/**
 * Production admin stance mutation handler (privilege + final freeze + upsert).
 */

import type { Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import type { StanceValue } from "./stanceHistory.js";

export type AdminStanceHandlerDeps = {
  getSessionUser: (req: Request) => { x_user_id: string; handle: string } | null;
  isPrivilegedManualEditorHandle: (handle: unknown) => boolean;
  normalizeHandle: (value: unknown) => string;
  normalizeStanceValue: (raw: unknown) => StanceValue | null;
  resolveProposalAccess: (opts: {
    rawProposal: unknown;
    sessionHandle: unknown;
  }) => Promise<{ proposalId: string; allowed: boolean; known: boolean }>;
  getProposalById: (id: string) => { status?: string } | null | undefined;
  isFinalProposalStatus: (status: unknown) => boolean;
  pool: Pool;
  upsertStanceWithHistory: (
    client: PoolClient,
    args: {
      xUserId: string;
      handle: string;
      name: string | null;
      avatarUrl: string | null;
      followersCount: number | null;
      stance: StanceValue;
      changedBy: "admin";
      proposalId: string;
    }
  ) => Promise<{ row: Record<string, unknown>; changed: boolean }>;
};

export function createAdminStanceHandler(deps: AdminStanceHandlerDeps) {
  return async function postAdminStance(req: Request, res: Response, next: NextFunction) {
    try {
      const user = deps.getSessionUser(req);
      if (!user || !deps.isPrivilegedManualEditorHandle(user.handle)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      const requestedStance = deps.normalizeStanceValue(req.body?.stance);
      if (!requestedStance) {
        res.status(400).json({ error: "invalid_stance" });
        return;
      }
      const reqXUserId = String(req.body?.x_user_id ?? "").trim();
      const reqHandle = deps.normalizeHandle(req.body?.handle);
      if (!reqXUserId && !reqHandle) {
        res.status(400).json({ error: "target_required" });
        return;
      }
      const access = await deps.resolveProposalAccess({
        rawProposal: req.body?.proposal ?? req.body?.proposal_id,
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

      const proposalMeta = deps.getProposalById(access.proposalId);
      if (deps.isFinalProposalStatus(proposalMeta?.status)) {
        res.status(409).json({
          error: "proposal_stances_frozen",
          message: "This proposal is a final locked snapshot. Positions can no longer be changed.",
        });
        return;
      }

      const client = await deps.pool.connect();
      try {
        await client.query("BEGIN");
        let existingRow: Record<string, unknown> | null = null;
        if (reqXUserId) {
          const byId = await client.query("SELECT * FROM community_users WHERE x_user_id = $1 LIMIT 1", [
            reqXUserId,
          ]);
          existingRow = (byId.rows[0] ?? null) as Record<string, unknown> | null;
        }
        if (!existingRow && reqHandle) {
          const byHandle = await client.query(
            "SELECT * FROM community_users WHERE lower(coalesce(handle, '')) = $1 LIMIT 1",
            [reqHandle]
          );
          existingRow = (byHandle.rows[0] ?? null) as Record<string, unknown> | null;
        }

        const resolvedHandle = deps.normalizeHandle(existingRow?.handle ?? reqHandle);
        if (!resolvedHandle) {
          res.status(400).json({ error: "target_handle_required" });
          await client.query("ROLLBACK");
          return;
        }
        const resolvedXUserId = String(
          existingRow?.x_user_id ?? (reqXUserId || `manual:${resolvedHandle}`)
        ).trim();

        const result = await deps.upsertStanceWithHistory(client, {
          xUserId: resolvedXUserId,
          handle: resolvedHandle,
          name: existingRow?.name ? String(existingRow.name) : null,
          avatarUrl: existingRow?.avatar_url ? String(existingRow.avatar_url) : null,
          followersCount:
            typeof existingRow?.followers_count === "number"
              ? (existingRow.followers_count as number)
              : Number(existingRow?.followers_count || 0) || null,
          stance: requestedStance,
          changedBy: "admin",
          proposalId: access.proposalId,
        });
        await client.query("COMMIT");
        res.json(result.row);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  };
}
