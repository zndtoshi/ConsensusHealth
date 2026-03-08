import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { fetchProfileEnrichmentFromTwitterApiIo } from "./profileEnrichment.js";

dotenv.config({ path: path.resolve(process.cwd(), "server", ".env") });

const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const TWITTERAPI_IO_KEY = (process.env.TWITTERAPI_IO_KEY || "").trim();

function fatal(msg: string): never {
  console.error(`\n[enrich:profiles] ${msg}\n`);
  process.exit(1);
}

function resolveConnectionString(): string {
  if (DATABASE_URL) return DATABASE_URL;
  const PGHOST = (process.env.PGHOST || "localhost").trim();
  const PGPORT = (process.env.PGPORT || "5432").trim();
  const PGDATABASE = (process.env.PGDATABASE || "consensushealth").trim();
  const PGUSER = (process.env.PGUSER || "postgres").trim();
  const PGPASSWORD = (process.env.PGPASSWORD || "").trim();
  if (!PGPASSWORD) fatal("DATABASE_URL missing and PGPASSWORD missing.");
  return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type InputUser = {
  x_user_id?: string | null;
  handle?: string | null;
  username?: string | null;
};

async function run(): Promise<void> {
  if (!TWITTERAPI_IO_KEY) fatal("TWITTERAPI_IO_KEY is required.");
  const usersPath = path.resolve(process.cwd(), "users.json");
  const usersRaw = await fs.readFile(usersPath, "utf-8");
  const parsed = JSON.parse(usersRaw);
  const sourceUsers: InputUser[] = Array.isArray(parsed) ? parsed : [];

  const uniq = new Map<string, { xUserId: string; handle: string }>();
  for (const row of sourceUsers) {
    const xUserId = String(row?.x_user_id ?? "").trim();
    const handle = String(row?.handle ?? row?.username ?? "").trim().toLowerCase().replace(/^@+/, "");
    const key = xUserId ? `id:${xUserId}` : handle ? `h:${handle}` : "";
    if (!key || uniq.has(key)) continue;
    uniq.set(key, { xUserId, handle });
  }

  const users = [...uniq.values()];
  const total = users.length;
  let processed = 0;
  let updated = 0;
  let failed = 0;

  const pool = new Pool({ connectionString: resolveConnectionString() });
  console.log("[enrich:profiles] total users:", total);

  for (const user of users) {
    processed += 1;
    try {
      const enrichment = await fetchProfileEnrichmentFromTwitterApiIo(
        { xUserId: user.xUserId, handle: user.handle },
        TWITTERAPI_IO_KEY
      );
      if (!enrichment) {
        failed += 1;
      } else {
        const params: Array<number | string | null> = [enrichment.bio, enrichment.accountCreatedAt];
        let whereSql = "";
        if (user.xUserId) {
          params.push(user.xUserId);
          whereSql = `x_user_id = $${params.length}`;
        } else if (user.handle) {
          params.push(user.handle);
          whereSql = `lower(coalesce(handle, '')) = $${params.length}`;
        } else {
          failed += 1;
          continue;
        }
        const q = await pool.query(
          `
          UPDATE community_users
          SET
            bio = $1,
            account_created_at = COALESCE(account_created_at, $2::timestamptz),
            updated_at = NOW()
          WHERE ${whereSql}
          `,
          params
        );
        const affected = Number(q.rowCount ?? 0);
        if (affected > 0) updated += affected;
      }
    } catch {
      failed += 1;
    }

    if (processed % 25 === 0 || processed === total) {
      console.log(`[enrich:profiles] processed=${processed}/${total} updated=${updated} failed=${failed}`);
    }
    await sleep(220);
  }

  await pool.end();
  console.log(`[enrich:profiles] done total=${total} processed=${processed} updated=${updated} failed=${failed}`);
}

run().catch((err) => {
  console.error("[enrich:profiles] fatal:", err);
  process.exit(1);
});
