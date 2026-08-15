/**
 * Authenticated account deletion (GDPR-style hard delete).
 * Prefer DELETE of identifiable rows over anonymization.
 * Writes a privacy_suppressions tombstone so curated seed identities cannot return.
 */

import fs from "node:fs";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { upsertPrivacySuppression } from "./privacySuppressions.js";

export type SessionUserForDeletion = {
  x_user_id: string;
  handle: string;
};

export type DeleteAccountResult =
  | { deleted: true; x_user_id: string; handle: string; avatar_path: string | null }
  | { deleted: false; reason: "not_found"; x_user_id: string; handle: string };

export type DeleteAuthenticatedAccountArgs = {
  pool: Pool;
  sessionUser: SessionUserForDeletion;
  avatarsDir: string;
  unlink?: (filePath: string) => Promise<void>;
  resolvePath?: typeof path.resolve;
};

export function normalizeDeletionHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

/**
 * Delete all identifiable rows for the authenticated user in one transaction.
 * Always upserts a privacy tombstone first (even if the community row is gone).
 * Local avatar file is removed best-effort after commit.
 */
export async function deleteAuthenticatedAccount(
  args: DeleteAuthenticatedAccountArgs
): Promise<DeleteAccountResult> {
  const xUserId = String(args.sessionUser.x_user_id || "").trim();
  const handle = normalizeDeletionHandle(args.sessionUser.handle);
  if (!xUserId || !handle) {
    return { deleted: false, reason: "not_found", x_user_id: xUserId, handle };
  }

  const client = await args.pool.connect();
  let avatarPath: string | null = null;
  let hadRow = false;
  try {
    await client.query("BEGIN");

    // Tombstone first so seed suppression survives even if later deletes fail mid-way
    // after commit of a partial path — kept in the same transaction.
    await upsertPrivacySuppression(client, { x_user_id: xUserId, handle });

    const existing = await client.query(
      `SELECT x_user_id, handle, avatar_path FROM community_users WHERE x_user_id = $1 LIMIT 1`,
      [xUserId]
    );
    if (existing.rows.length === 0) {
      await client.query(`DELETE FROM sessions WHERE x_user_id = $1`, [xUserId]);
      // Do NOT delete privacy_suppressions — tombstone must remain.
      await client.query("COMMIT");
      return { deleted: false, reason: "not_found", x_user_id: xUserId, handle };
    }

    hadRow = true;
    const row = existing.rows[0] as {
      x_user_id: string;
      handle: string | null;
      avatar_path: string | null;
    };
    avatarPath = row.avatar_path != null ? String(row.avatar_path) : null;

    await client.query(`DELETE FROM user_proposal_stance_explanations WHERE x_user_id = $1`, [
      xUserId,
    ]);
    await client.query(`DELETE FROM user_proposal_stance_history WHERE x_user_id = $1`, [xUserId]);
    await client.query(`DELETE FROM user_proposal_stances WHERE x_user_id = $1`, [xUserId]);
    await client.query(`DELETE FROM stance_history WHERE x_user_id = $1`, [xUserId]);
    await client.query(`DELETE FROM stance_events WHERE x_user_id = $1`, [xUserId]);
    await client.query(`DELETE FROM name_the_fork_votes WHERE x_user_id = $1`, [xUserId]);
    // Keep custom candidates that others voted for, but strip proposer identity.
    await client.query(
      `UPDATE name_the_fork_candidates
       SET proposer_x_user_id = NULL, proposer_handle = NULL
       WHERE proposer_x_user_id = $1`,
      [xUserId]
    );
    await client.query(`DELETE FROM sessions WHERE x_user_id = $1`, [xUserId]);
    // Admin moderation list is unrelated; clear any matching rows so they cannot
    // be confused with privacy tombstones. Privacy suppressions stay.
    await client.query(
      `DELETE FROM removed_community_users WHERE x_user_id = $1 OR lower(coalesce(handle, '')) = $2`,
      [xUserId, handle]
    );
    await client.query(`DELETE FROM community_users WHERE x_user_id = $1`, [xUserId]);

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    client.release();
  }

  await bestEffortDeleteAvatarFile({
    avatarsDir: args.avatarsDir,
    avatarPath,
    unlink: args.unlink,
    resolvePath: args.resolvePath,
  });

  if (!hadRow) {
    return { deleted: false, reason: "not_found", x_user_id: xUserId, handle };
  }
  return { deleted: true, x_user_id: xUserId, handle, avatar_path: avatarPath };
}

export function resolveSafeAvatarFilesystemPath(
  avatarsDir: string,
  avatarPath: string | null | undefined,
  resolvePath: typeof path.resolve = path.resolve
): string | null {
  const publicPath = String(avatarPath ?? "").trim();
  if (!publicPath) return null;
  const base = publicPath.replace(/\\/g, "/");
  const filename = base.startsWith("/avatars/")
    ? base.slice("/avatars/".length)
    : path.basename(base);
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return null;
  }
  const root = resolvePath(avatarsDir);
  const full = resolvePath(root, filename);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) {
    return null;
  }
  return full;
}

async function bestEffortDeleteAvatarFile(args: {
  avatarsDir: string;
  avatarPath: string | null;
  unlink?: (filePath: string) => Promise<void>;
  resolvePath?: typeof path.resolve;
}): Promise<void> {
  const full = resolveSafeAvatarFilesystemPath(
    args.avatarsDir,
    args.avatarPath,
    args.resolvePath ?? path.resolve
  );
  if (!full) return;
  const unlink =
    args.unlink ??
    (async (p: string) => {
      await fs.promises.unlink(p);
    });
  try {
    await unlink(full);
  } catch {
    // best-effort
  }
}

export type AccountDeletionHandlerDeps = {
  pool: Pool;
  getSessionUser: (req: Request) => SessionUserForDeletion | null;
  avatarsDir: string;
  invalidateStatsCache: () => void;
  clearSessionCookie: (res: Response) => void;
  deleteAccount?: typeof deleteAuthenticatedAccount;
};

export function createAccountDeletionHandler(deps: AccountDeletionHandlerDeps) {
  const deleteAccount = deps.deleteAccount ?? deleteAuthenticatedAccount;

  return async function accountDeletionHandler(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const user = deps.getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "not_logged_in" });
        return;
      }

      const confirm = normalizeDeletionHandle(req.body?.confirm_handle);
      const sessionHandle = normalizeDeletionHandle(user.handle);
      if (!confirm || confirm !== sessionHandle) {
        res.status(400).json({
          error: "confirm_handle_mismatch",
          message: "confirm_handle must match your signed-in handle.",
        });
        return;
      }

      const result = await deleteAccount({
        pool: deps.pool,
        sessionUser: { x_user_id: user.x_user_id, handle: sessionHandle },
        avatarsDir: deps.avatarsDir,
      });

      deps.clearSessionCookie(res);
      deps.invalidateStatsCache();

      // Idempotent: tombstone is always present after a successful call path.
      res.status(200).json({
        ok: true,
        deleted: result.deleted,
        suppressed: true,
      });
    } catch (err) {
      next(err);
    }
  };
}

/** Tables touched by deleteAuthenticatedAccount (for tests). */
export const ACCOUNT_DELETION_SQL_TABLES = [
  "privacy_suppressions",
  "user_proposal_stance_explanations",
  "user_proposal_stance_history",
  "user_proposal_stances",
  "stance_history",
  "stance_events",
  "name_the_fork_votes",
  "sessions",
  "removed_community_users",
  "community_users",
] as const;

export type { PoolClient };
