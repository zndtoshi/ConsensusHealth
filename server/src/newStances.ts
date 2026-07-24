import type { Pool } from "pg";
import { normalizeStanceValue } from "./stanceHistory.js";
import { DEFAULT_PROPOSAL_ID, type ProposalId } from "./proposalCatalog.js";

export const NEW_STANCES_MAX_LIMIT = 9;

export type NewStanceEventRow = {
  eventId: number;
  xUserId: string;
  handle: string;
  displayName: string | null;
  stance: "against" | "neutral" | "approve";
  createdAt: string;
  avatarPath: string | null;
  hasAvatarBlob: boolean;
};

export function clampNewStancesLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NEW_STANCES_MAX_LIMIT;
  return Math.max(1, Math.min(NEW_STANCES_MAX_LIMIT, Math.trunc(n)));
}

export function mapNewStanceEventRow(r: Record<string, unknown>): NewStanceEventRow | null {
  const eventId = Number(r.id);
  const xUserId = String(r.x_user_id ?? "").trim();
  const stance = normalizeStanceValue(r.new_stance);
  if (!Number.isFinite(eventId) || eventId <= 0 || !xUserId || !stance) return null;
  const handle = String(r.handle ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  const avatarPathRaw = String(r.avatar_path ?? "").trim();
  return {
    eventId: Math.trunc(eventId),
    xUserId,
    handle,
    displayName: r.name != null && String(r.name).trim() ? String(r.name) : null,
    stance,
    createdAt: new Date(String(r.changed_at)).toISOString(),
    avatarPath: avatarPathRaw || null,
    hasAvatarBlob: Boolean(avatarPathRaw),
  };
}

/**
 * Latest-per-user stance events from canonical user_proposal_stance_history.
 */
export async function queryNewStanceEvents(
  pool: Pool,
  opts: { afterEventId?: number | null; limit: number; proposalId?: ProposalId }
): Promise<NewStanceEventRow[]> {
  const limit = clampNewStancesLimit(opts.limit);
  const proposalId = opts.proposalId || DEFAULT_PROPOSAL_ID;
  const params: Array<string | number> = [proposalId];
  let afterSql = "";

  if (opts.afterEventId != null && Number.isFinite(opts.afterEventId) && opts.afterEventId > 0) {
    params.push(Math.trunc(opts.afterEventId));
    afterSql = `
      AND (l.changed_at, l.id) > (
        SELECT sh.changed_at, sh.id
        FROM user_proposal_stance_history sh
        WHERE sh.id = $${params.length}
      )`;
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await pool.query(
    `
    WITH latest AS (
      SELECT
        sh.id,
        sh.x_user_id,
        sh.new_stance,
        sh.changed_at,
        sh.changed_by,
        ROW_NUMBER() OVER (
          PARTITION BY sh.x_user_id
          ORDER BY sh.changed_at DESC, sh.id DESC
        ) AS rn
      FROM user_proposal_stance_history sh
      WHERE sh.proposal_id = $1
        AND sh.changed_by IN ('user', 'admin')
    )
    SELECT
      l.id,
      l.x_user_id,
      l.new_stance,
      l.changed_at,
      lower(trim(coalesce(cu.handle, ''))) AS handle,
      cu.name,
      cu.avatar_path
    FROM latest l
    INNER JOIN community_users cu ON cu.x_user_id = l.x_user_id
    INNER JOIN user_proposal_stances ups
      ON ups.x_user_id = cu.x_user_id AND ups.proposal_id = $1
    WHERE l.rn = 1
      AND trim(coalesce(cu.handle, '')) <> ''
      ${afterSql}
    ORDER BY l.changed_at DESC, l.id DESC
    LIMIT ${limitParam}
    `,
    params
  );

  const out: NewStanceEventRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const mapped = mapNewStanceEventRow(row as Record<string, unknown>);
    if (!mapped || !mapped.handle) continue;
    if (seen.has(mapped.xUserId)) continue;
    seen.add(mapped.xUserId);
    out.push(mapped);
  }
  return out;
}
