import type { Pool } from "pg";
import {
  createAvatarProvisioner,
  type AvatarBlob,
  type AvatarBlobReader,
  type AvatarBlobStore,
  type AvatarFetchFailureReason,
  type AvatarImageResponse,
  type AvatarProvisioner,
} from "./avatarStore.js";

/**
 * Postgres + HTTP wiring for the permanent avatar store. This is the single
 * place that turns the pure logic in `avatarStore.ts` into a live,
 * database-backed provisioner, shared by the server and the backfill script.
 */

export function createPgAvatarBlobStore(pool: Pool): AvatarBlobStore {
  return {
    async has(xUserId) {
      const r = await pool.query("SELECT 1 FROM avatar_blobs WHERE x_user_id = $1 LIMIT 1", [xUserId]);
      return (r.rowCount ?? 0) > 0;
    },
    async insertIfAbsent(xUserId, mimeType, bytes) {
      const r = await pool.query(
        `INSERT INTO avatar_blobs (x_user_id, mime_type, image_bytes)
         VALUES ($1, $2, $3)
         ON CONFLICT (x_user_id) DO NOTHING`,
        [xUserId, mimeType, bytes]
      );
      return (r.rowCount ?? 0) > 0;
    },
  };
}

export function createPgAvatarBlobReader(pool: Pool): AvatarBlobReader {
  return {
    async get(xUserId): Promise<AvatarBlob | null> {
      const r = await pool.query("SELECT mime_type, image_bytes FROM avatar_blobs WHERE x_user_id = $1 LIMIT 1", [
        xUserId,
      ]);
      const row = r.rows[0] as { mime_type?: string; image_bytes?: Buffer } | undefined;
      if (!row || !row.image_bytes) return null;
      return { mimeType: String(row.mime_type ?? "application/octet-stream"), bytes: row.image_bytes };
    },
  };
}

/** Download an image over HTTP, shaped for `fetchValidatedAvatarImage`. */
export async function fetchAvatarImageOverHttp(url: string): Promise<AvatarImageResponse> {
  const resp = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "ConsensusHealthAvatarFetcher/1.0", accept: "image/*" },
  });
  return {
    ok: resp.ok,
    status: resp.status,
    contentType: resp.headers.get("content-type"),
    arrayBuffer: () => resp.arrayBuffer(),
  };
}

export function createDbAvatarProvisioner(
  pool: Pool,
  opts?: { isProd?: boolean; onError?: (xUserId: string, reason: AvatarFetchFailureReason) => void }
): { store: AvatarBlobStore; reader: AvatarBlobReader; provisioner: AvatarProvisioner } {
  const store = createPgAvatarBlobStore(pool);
  const reader = createPgAvatarBlobReader(pool);
  const onError =
    opts?.onError ??
    ((xUserId: string, reason: AvatarFetchFailureReason) => {
      if (!opts?.isProd) console.warn("[avatar-store] provisioning skipped", { xUserId, reason });
    });
  const provisioner = createAvatarProvisioner({ store, fetchImage: fetchAvatarImageOverHttp, onError });
  return { store, reader, provisioner };
}

/**
 * Permanent, immutable avatar storage keyed by the stable X user ID. Idempotent
 * so it is safe to call from server startup and from the standalone backfill.
 */
export async function ensureAvatarBlobsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS avatar_blobs (
      x_user_id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL,
      image_bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
