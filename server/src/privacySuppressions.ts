/**
 * Privacy-deletion tombstones. Prevent curated/seed identities from reappearing
 * after a user deletes their account. Distinct from admin moderation removals.
 */

import type { Pool, PoolClient } from "pg";

export type PrivacySuppression = {
  x_user_id: string;
  handle_normalized: string;
  created_at?: string;
};

export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function normalizeSuppressionHandle(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

export async function ensurePrivacySuppressionsTable(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS privacy_suppressions (
      x_user_id TEXT PRIMARY KEY,
      handle_normalized TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS privacy_suppressions_handle_idx
      ON privacy_suppressions (handle_normalized)
  `);
}

/** Upsert a privacy tombstone. Never deleted by account deletion. */
export async function upsertPrivacySuppression(
  db: Queryable,
  input: { x_user_id: string; handle: string }
): Promise<PrivacySuppression> {
  const xUserId = String(input.x_user_id || "").trim();
  const handle = normalizeSuppressionHandle(input.handle);
  if (!xUserId || !handle) {
    throw new Error("privacy_suppression_requires_id_and_handle");
  }
  const result = await db.query(
    `INSERT INTO privacy_suppressions (x_user_id, handle_normalized)
     VALUES ($1, $2)
     ON CONFLICT (x_user_id) DO UPDATE
       SET handle_normalized = EXCLUDED.handle_normalized
     RETURNING x_user_id, handle_normalized, created_at`,
    [xUserId, handle]
  );
  const row = result.rows[0] as PrivacySuppression;
  return {
    x_user_id: String(row.x_user_id),
    handle_normalized: String(row.handle_normalized),
    created_at: row.created_at != null ? String(row.created_at) : undefined,
  };
}

export async function loadPrivacySuppressionKeys(db: Queryable): Promise<{
  xUserIds: Set<string>;
  handles: Set<string>;
}> {
  const result = await db.query(
    `SELECT x_user_id, handle_normalized FROM privacy_suppressions`
  );
  const xUserIds = new Set<string>();
  const handles = new Set<string>();
  for (const row of result.rows as Array<{ x_user_id: unknown; handle_normalized: unknown }>) {
    const id = String(row.x_user_id ?? "").trim();
    const handle = normalizeSuppressionHandle(row.handle_normalized);
    if (id) xUserIds.add(id);
    if (handle) handles.add(handle);
  }
  return { xUserIds, handles };
}

export function isPrivacySuppressed(
  account: { x_user_id?: unknown; handle?: unknown } | null | undefined,
  keys: { xUserIds: Set<string>; handles: Set<string> }
): boolean {
  if (!account) return false;
  const id = String(account.x_user_id ?? "").trim();
  const handle = normalizeSuppressionHandle(account.handle);
  if (id && keys.xUserIds.has(id)) return true;
  if (handle && keys.handles.has(handle)) return true;
  return false;
}

export function filterPrivacySuppressedAccounts<T extends { x_user_id?: unknown; handle?: unknown }>(
  accounts: T[],
  keys: { xUserIds: Set<string>; handles: Set<string> }
): T[] {
  return accounts.filter((a) => !isPrivacySuppressed(a, keys));
}
