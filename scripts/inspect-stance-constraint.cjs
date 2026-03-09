const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ path: path.resolve(__dirname, "../server/.env") });

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const q = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = 'community_users_stance_check'
      LIMIT 1
    `);
    console.log(q.rows[0] || null);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
