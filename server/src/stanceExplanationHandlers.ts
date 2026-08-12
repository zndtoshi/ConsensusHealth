/**
 * Production HTTP handlers for proposal-scoped stance explanations.
 * Wired by index.ts and exercised directly by HTTP tests with injected deps.
 */

import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import type { StanceValue } from "./stanceHistory.js";
import type { StanceExplanationPublicDto, VerifyAndUpsertResult } from "./stanceExplanations.js";

export type SessionIdentity = {
  x_user_id: string;
  handle: string;
};

export type ProposalAccessResult = {
  proposalId: string;
  allowed: boolean;
  known: boolean;
};

export type StanceExplanationHandlerDeps = {
  getSessionUser: (req: Request) => SessionIdentity | null;
  resolveProposalAccess: (opts: {
    rawProposal: unknown;
    sessionHandle: unknown;
  }) => Promise<ProposalAccessResult>;
  pool: Pool;
  normalizeStanceValue: (raw: unknown) => StanceValue | null;
  verifyAndUpsertStanceExplanation: (
    pool: Pool,
    args: {
      xUserId: string;
      handle: string;
      proposalId: string;
      tweetUrl: unknown;
      fetchImpl?: typeof fetch;
    }
  ) => Promise<VerifyAndUpsertResult>;
  confirmExplanationForStance: (
    pool: Pool,
    args: { xUserId: string; proposalId: string; stance: StanceValue }
  ) => Promise<StanceExplanationPublicDto | null>;
  deleteStanceExplanation: (
    pool: Pool,
    args: { xUserId: string; proposalId: string }
  ) => Promise<void>;
  fetchImpl?: typeof fetch;
};

export function createStanceExplanationHandlers(deps: StanceExplanationHandlerDeps) {
  async function putStanceExplanation(req: Request, res: Response, next: NextFunction) {
    try {
      const user = deps.getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "not_logged_in" });
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

      const confirmExisting = Boolean(req.body?.confirm_existing);
      if (confirmExisting) {
        const stanceRes = await deps.pool.query(
          `SELECT stance FROM user_proposal_stances WHERE x_user_id = $1 AND proposal_id = $2 LIMIT 1`,
          [user.x_user_id, access.proposalId]
        );
        const stance = deps.normalizeStanceValue(stanceRes.rows[0]?.stance);
        if (!stance) {
          res.status(409).json({
            error: "stance_required",
            message: "Choose a position before attaching an explanation.",
          });
          return;
        }
        const explanation = await deps.confirmExplanationForStance(deps.pool, {
          xUserId: user.x_user_id,
          proposalId: access.proposalId,
          stance,
        });
        if (!explanation) {
          res.status(404).json({ error: "explanation_missing" });
          return;
        }
        res.json({ explanation });
        return;
      }

      const result = await deps.verifyAndUpsertStanceExplanation(deps.pool, {
        xUserId: user.x_user_id,
        handle: user.handle,
        proposalId: access.proposalId,
        tweetUrl: req.body?.tweet_url ?? req.body?.tweetUrl,
        fetchImpl: deps.fetchImpl,
      });
      if (!result.ok) {
        res.status(result.status).json({
          error: result.error,
          ...(result.message ? { message: result.message } : {}),
        });
        return;
      }
      res.json({ explanation: result.explanation });
    } catch (err) {
      next(err);
    }
  }

  async function deleteStanceExplanationHandler(req: Request, res: Response, next: NextFunction) {
    try {
      const user = deps.getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "not_logged_in" });
        return;
      }

      const access = await deps.resolveProposalAccess({
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

      await deps.deleteStanceExplanation(deps.pool, {
        xUserId: user.x_user_id,
        proposalId: access.proposalId,
      });
      res.json({ removed: true, proposal_id: access.proposalId });
    } catch (err) {
      next(err);
    }
  }

  return { putStanceExplanation, deleteStanceExplanationHandler };
}
