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

function hasText(v) {
  return String(v || "").trim().length > 0;
}

async function main() {
  const dbUrl = String(process.env.DATABASE_URL || "").trim();
  if (!dbUrl) throw new Error("DATABASE_URL is missing in server/.env");

  const usersPath = path.resolve(__dirname, "../users.json");
  const sourceRaw = JSON.parse(fs.readFileSync(usersPath, "utf8"));
  const sourceList = Array.isArray(sourceRaw)
    ? sourceRaw
    : Array.isArray(sourceRaw?.users)
    ? sourceRaw.users
    : [];

  const dedup = new Map();
  for (const row of sourceList) {
    const xUserId = String(row?.x_user_id ?? "").trim();
    const handle = normHandle(row?.handle ?? row?.username ?? "");
    const key = xUserId ? `id:${xUserId}` : handle ? `h:${handle}` : "";
    if (!key || dedup.has(key)) continue;
    dedup.set(key, { xUserId, handle });
  }
  const users = Array.from(dedup.values());

  const pool = new Pool({ connectionString: dbUrl });
  try {
    const { rows } = await pool.query(`
      SELECT x_user_id, handle, bio
      FROM community_users
    `);

    const byId = new Map();
    const byHandle = new Map();
    for (const row of rows) {
      const id = String(row.x_user_id ?? "").trim();
      const handle = normHandle(row.handle);
      if (id) byId.set(id, row);
      if (handle) byHandle.set(handle, row);
    }

    const missingDb = [];
    const matchedNoBio = [];
    const matchedWithBio = [];

    for (const user of users) {
      const row =
        (user.xUserId && byId.get(user.xUserId)) ||
        (user.handle && byHandle.get(user.handle)) ||
        null;
      if (!row) {
        missingDb.push(user);
        continue;
      }
      if (hasText(row.bio)) matchedWithBio.push(user);
      else matchedNoBio.push(user);
    }

    const report = {
      generated_at: new Date().toISOString(),
      users_json_total_raw: sourceList.length,
      users_json_total_dedup: users.length,
      community_users_total_rows: rows.length,
      matched_with_bio: matchedWithBio.length,
      matched_without_bio: matchedNoBio.length,
      missing_in_db: missingDb.length,
      sample_missing_in_db: missingDb.slice(0, 25),
      sample_matched_without_bio: matchedNoBio.slice(0, 25),
    };

    const outPath = path.resolve(__dirname, "../users_bio_coverage_report.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    console.log(`Coverage report written to ${outPath}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
