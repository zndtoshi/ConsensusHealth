const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../server/.env") });

function normHandle(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

async function main() {
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is missing in server/.env");
  }

  const pool = new Pool({ connectionString });
  try {
    const usersPath = path.resolve(__dirname, "../users.json");
    const usersRaw = JSON.parse(fs.readFileSync(usersPath, "utf8"));
    const sourceUsers = Array.isArray(usersRaw)
      ? usersRaw
      : Array.isArray(usersRaw?.users)
      ? usersRaw.users
      : [];

    const dedup = new Map();
    for (const row of sourceUsers) {
      const xUserId = String(row?.x_user_id ?? "").trim();
      const handle = normHandle(row?.handle ?? row?.username ?? "");
      const key = xUserId ? `id:${xUserId}` : handle ? `h:${handle}` : "";
      if (!key || dedup.has(key)) continue;
      dedup.set(key, {
        x_user_id: xUserId || null,
        handle: handle || null,
      });
    }

    const sql = `
      SELECT
        x_user_id,
        handle,
        name,
        avatar_url,
        followers_count,
        stance,
        bio,
        account_created_at,
        updated_at
      FROM community_users
      WHERE coalesce(trim(bio), '') != ''
      ORDER BY lower(coalesce(handle, '')) ASC
    `;
    const { rows } = await pool.query(sql.replace("WHERE coalesce(trim(bio), '') != ''", ""));
    const byId = new Map();
    const byHandle = new Map();
    for (const row of rows) {
      const id = String(row.x_user_id ?? "").trim();
      const h = normHandle(row.handle);
      if (id) byId.set(id, row);
      if (h) byHandle.set(h, row);
    }

    const merged = [];
    for (const src of dedup.values()) {
      const dbRow =
        (src.x_user_id && byId.get(src.x_user_id)) ||
        (src.handle && byHandle.get(src.handle)) ||
        null;
      merged.push({
        x_user_id: src.x_user_id,
        handle: src.handle,
        in_db: Boolean(dbRow),
        has_bio: Boolean(String(dbRow?.bio ?? "").trim()),
        name: dbRow?.name ?? null,
        avatar_url: dbRow?.avatar_url ?? null,
        followers_count: dbRow?.followers_count ?? null,
        stance: dbRow?.stance ?? null,
        bio: dbRow?.bio ?? null,
        account_created_at: dbRow?.account_created_at ?? null,
        updated_at: dbRow?.updated_at ?? null,
      });
    }

    const withBio = merged.filter((r) => r.has_bio).length;
    const inDb = merged.filter((r) => r.in_db).length;
    const outPath = path.resolve(__dirname, "../users_bio_export.json");
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          total_from_users_json: merged.length,
          matched_in_db: inDb,
          with_bio: withBio,
          users: merged,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`Exported ${merged.length} users to ${outPath} (in_db=${inDb}, with_bio=${withBio})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
