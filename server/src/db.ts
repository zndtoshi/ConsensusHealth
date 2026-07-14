import { Pool } from "pg";

/**
 * Shared Postgres connection setup so both the server (`index.ts`) and one-off
 * scripts (e.g. the avatar backfill) connect using the exact same
 * `DATABASE_URL` / `PG*` environment logic. Throws on misconfiguration; callers
 * decide how to report/exit.
 */
export function resolveConnectionString(): string {
  const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
  let connectionString = DATABASE_URL;

  if (!connectionString) {
    const PGHOST = (process.env.PGHOST || "localhost").trim();
    const PGPORT = (process.env.PGPORT || "5432").trim();
    const PGDATABASE = (process.env.PGDATABASE || "consensushealth").trim();
    const PGUSER = (process.env.PGUSER || "postgres").trim();
    const PGPASSWORD = (process.env.PGPASSWORD || "").trim();

    if (!PGPASSWORD) {
      throw new Error("DATABASE_URL is missing, and PGPASSWORD is missing. Postgres SCRAM requires a password.");
    }

    const encodedUser = encodeURIComponent(PGUSER);
    const encodedPass = encodeURIComponent(PGPASSWORD);
    connectionString = `postgresql://${encodedUser}:${encodedPass}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (!parsed.password) {
    throw new Error("DATABASE_URL does not include a password. Use postgresql://user:PASSWORD@host:port/db");
  }

  return connectionString;
}

/** Redact the password when logging a connection string. */
export function redactConnectionString(connectionString: string): string {
  return connectionString.replace(/:(?:[^@]*)@/, ":***@");
}

export function createPool(connectionString?: string): Pool {
  return new Pool({ connectionString: connectionString ?? resolveConnectionString() });
}
