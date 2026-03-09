const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

// Reuse project env loading convention (server/.env), but require PROD_DATABASE_URL for safety.
dotenv.config({ path: path.resolve(__dirname, "../server/.env") });

const JSON_PATH = path.resolve(__dirname, "../users_bio_export.json");
const TARGET_TABLE = (process.env.TARGET_TABLE || "public.community_users").trim();
const DRY_RUN = String(process.env.DRY_RUN || "").trim() === "1";
const INSPECT_TABLES = String(process.env.INSPECT_TABLES || "").trim() === "1";
const DIAGNOSE_MISMATCHES = String(process.env.DIAGNOSE_MISMATCHES || "").trim() === "1";
const PROD_DATABASE_URL = String(
  process.env.PROD_DATABASE_URL || process.env.DATABASE_URL || ""
).trim();
const MISMATCH_REPORT_PATH = path.resolve(__dirname, "../backfill_bio_mismatch_report.json");

function fatal(msg) {
  console.error(`\n[backfill:prod:bios] ${msg}\n`);
  process.exit(1);
}

function validateDatabaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    fatal(
      "Missing DB URL. Set PROD_DATABASE_URL to the Render production Postgres connection string."
    );
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol.startsWith("postgres")) {
      fatal("DB URL must use postgres/postgresql protocol.");
    }
    const host = String(parsed.hostname || "").toLowerCase();
    const looksLocal = host === "localhost" || host === "127.0.0.1";
    if (looksLocal && String(process.env.ALLOW_LOCAL_DB || "") !== "1") {
      fatal(
        "Refusing to run against localhost/127.0.0.1. " +
          "Use production Render URL in PROD_DATABASE_URL."
      );
    }
  } catch {
    fatal("DB URL is not a valid URL.");
  }
}

function validXId(x) {
  if (!x) return false;
  const s = String(x).trim();
  if (!s) return false;
  if (s.startsWith("manual:")) return false;
  return true;
}

function normalizeXId(x) {
  return String(x || "").trim();
}

function normalizeHandle(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function lowerTrimHandle(v) {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function readUsersFromExport() {
  if (!fs.existsSync(JSON_PATH)) {
    fatal(`Missing export file: ${JSON_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const users = Array.isArray(parsed?.users) ? parsed.users : [];
  if (!users.length) {
    fatal("No users found in users_bio_export.json (expected shape: { users: [...] }).");
  }
  return users;
}

async function inspectTables(pool) {
  const baseTables = await pool.query(
    `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
    `
  );

  const matchingColumns = await pool.query(
    `
    SELECT
      table_schema,
      table_name,
      array_agg(column_name ORDER BY column_name) AS matched_columns
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND column_name IN ('x_user_id', 'handle', 'bio', 'account_created_at', 'stance')
    GROUP BY table_schema, table_name
    ORDER BY table_schema, table_name
    `
  );

  console.log("\n[backfill:prod:bios] INSPECT_TABLES mode");
  console.log({ total_base_tables: baseTables.rows.length });
  console.log("Base tables (schema.table):");
  for (const row of baseTables.rows) {
    console.log(`- ${row.table_schema}.${row.table_name}`);
  }

  console.log("\nTables with target-like columns:");
  if (!matchingColumns.rows.length) {
    console.log("- none");
    return;
  }
  for (const row of matchingColumns.rows) {
    const cols = Array.isArray(row.matched_columns) ? row.matched_columns.join(", ") : "";
    console.log(`- ${row.table_schema}.${row.table_name} -> [${cols}]`);
  }

  const explicitTables = [
    { schema: "public", name: "community_users" },
    { schema: "public", name: "stance_events" },
    { schema: "public", name: "stance_history" },
  ];

  console.log("\nFull column list for requested tables:");
  for (const t of explicitTables) {
    const cols = await pool.query(
      `
      SELECT
        column_name,
        data_type,
        is_nullable,
        ordinal_position
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
      `,
      [t.schema, t.name]
    );
    if (!cols.rows.length) {
      console.log(`- ${t.schema}.${t.name}: (table not found or no visible columns)`);
      continue;
    }
    console.log(`- ${t.schema}.${t.name}:`);
    for (const c of cols.rows) {
      console.log(
        `  - ${c.ordinal_position}. ${c.column_name} (${c.data_type}, nullable=${c.is_nullable})`
      );
    }
  }
}

async function updateByXUserId(pool, bio, accountCreatedAt, xUserId) {
  const fields = [];
  const params = [];
  if (bio !== null && bio !== undefined) {
    fields.push(`bio = $${params.length + 1}`);
    params.push(bio);
  }
  if (accountCreatedAt !== null && accountCreatedAt !== undefined) {
    fields.push(`account_created_at = $${params.length + 1}`);
    params.push(accountCreatedAt);
  }
  if (!fields.length) return 0;
  params.push(String(xUserId));
  const sql = `
    UPDATE ${TARGET_TABLE}
    SET ${fields.join(", ")}
    WHERE x_user_id = $${params.length}
  `;
  const result = await pool.query(sql, params);
  return Number(result.rowCount || 0);
}

async function updateByHandle(pool, bio, accountCreatedAt, handle) {
  const normalized = normalizeHandle(handle);
  if (!normalized) return 0;
  const fields = [];
  const params = [];
  if (bio !== null && bio !== undefined) {
    fields.push(`bio = $${params.length + 1}`);
    params.push(bio);
  }
  if (accountCreatedAt !== null && accountCreatedAt !== undefined) {
    fields.push(`account_created_at = $${params.length + 1}`);
    params.push(accountCreatedAt);
  }
  if (!fields.length) return 0;
  params.push(normalized);
  const sql = `
    UPDATE ${TARGET_TABLE}
    SET ${fields.join(", ")}
    WHERE lower(coalesce(handle, '')) = $${params.length}
  `;
  const result = await pool.query(sql, params);
  return Number(result.rowCount || 0);
}

async function loadLookupMaps(pool) {
  const q = await pool.query(
    `
    SELECT x_user_id, handle
    FROM ${TARGET_TABLE}
    `
  );
  const xIds = new Set();
  const handlesLowerTrim = new Set();
  const handlesNoAt = new Set();
  for (const row of q.rows) {
    const x = normalizeXId(row.x_user_id);
    const lowerTrim = lowerTrimHandle(row.handle);
    const noAt = normalizeHandle(row.handle);
    if (x) xIds.add(x);
    if (lowerTrim) handlesLowerTrim.add(lowerTrim);
    if (noAt) handlesNoAt.add(noAt);
  }
  return { xIds, handlesLowerTrim, handlesNoAt, totalRows: q.rows.length };
}

function classifyReason(entry) {
  if (!entry.normalized_x_user_id && !entry.normalized_handle_no_at) return "blank_id_and_handle";
  if (entry.is_manual_id) return "manual_id";
  if (entry.x_lookup_attempted && !entry.exists_by_x_user_id_normalized && entry.exists_by_handle_no_at) {
    return "x_user_id_mismatch_handle_exists";
  }
  if (entry.handle_fallback_attempted && !entry.exists_by_handle_no_at && entry.exists_by_x_user_id_normalized) {
    return "handle_mismatch_x_user_id_exists";
  }
  if (
    entry.normalized_handle_lower_trim &&
    entry.normalized_handle_no_at &&
    !entry.exists_by_handle_lower_trim &&
    entry.exists_by_handle_no_at
  ) {
    return "normalization_issue";
  }
  return "missing_in_db";
}

async function diagnoseMismatches(pool, users) {
  const lookups = await loadLookupMaps(pool);
  const reportEntries = [];
  const reasonCounts = {
    missing_in_db: 0,
    x_user_id_mismatch_handle_exists: 0,
    handle_mismatch_x_user_id_exists: 0,
    manual_id: 0,
    blank_id_and_handle: 0,
    normalization_issue: 0,
  };

  let scanned = 0;
  let skippedBothNull = 0;
  let wouldUpdate = 0;
  let wouldNotFound = 0;

  for (const user of users) {
    scanned += 1;
    const bio = user?.bio ?? null;
    const accountCreatedAt = user?.account_created_at ?? null;
    const xUserIdRaw = user?.x_user_id ?? null;
    const handleRaw = user?.handle ?? null;

    if (bio === null && accountCreatedAt === null) {
      skippedBothNull += 1;
      continue;
    }

    const normalizedXUserId = normalizeXId(xUserIdRaw);
    const normalizedHandleLowerTrim = lowerTrimHandle(handleRaw);
    const normalizedHandleNoAt = normalizeHandle(handleRaw);
    const isManualId = normalizedXUserId.startsWith("manual:");

    const xLookupAttempted = validXId(xUserIdRaw);
    const existsByX = normalizedXUserId ? lookups.xIds.has(normalizedXUserId) : false;

    // Keep this aligned to current backfill fallback check.
    const handleFallbackAttempted = !existsByX && Boolean(handleRaw);
    const existsByHandleLowerTrim = normalizedHandleLowerTrim
      ? lookups.handlesLowerTrim.has(normalizedHandleLowerTrim)
      : false;
    const existsByHandleNoAt = normalizedHandleNoAt
      ? lookups.handlesNoAt.has(normalizedHandleNoAt)
      : false;

    const wouldMatchCurrentRule = (xLookupAttempted && existsByX) || handleFallbackAttempted && existsByHandleNoAt;
    if (wouldMatchCurrentRule) {
      wouldUpdate += 1;
      continue;
    }

    wouldNotFound += 1;
    const entry = {
      x_user_id: xUserIdRaw,
      handle: handleRaw,
      normalized_x_user_id: normalizedXUserId || null,
      normalized_handle_lower_trim: normalizedHandleLowerTrim || null,
      normalized_handle_no_at: normalizedHandleNoAt || null,
      is_manual_id: isManualId,
      x_lookup_attempted: xLookupAttempted,
      handle_fallback_attempted: handleFallbackAttempted,
      exists_by_x_user_id_normalized: existsByX,
      exists_by_handle_lower_trim: existsByHandleLowerTrim,
      exists_by_handle_no_at: existsByHandleNoAt,
      x_user_id_match_failed_but_handle_exists:
        xLookupAttempted && !existsByX && (existsByHandleLowerTrim || existsByHandleNoAt),
      handle_match_failed_but_x_user_id_exists:
        handleFallbackAttempted && !existsByHandleNoAt && existsByX,
    };
    const reason = classifyReason(entry);
    entry.reason = reason;
    reasonCounts[reason] += 1;
    reportEntries.push(entry);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    mode: "diagnose_mismatches",
    target_table: TARGET_TABLE,
    json_path: JSON_PATH,
    report_path: MISMATCH_REPORT_PATH,
    table_rows_scanned_for_lookup: lookups.totalRows,
    scanned,
    would_update_rows: wouldUpdate,
    skipped_both_null: skippedBothNull,
    would_not_found_rows: wouldNotFound,
    reasons: reasonCounts,
    entries: reportEntries,
  };

  fs.writeFileSync(MISMATCH_REPORT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log("\n[backfill:prod:bios] DIAGNOSE_MISMATCHES mode");
  console.log({
    target_table: TARGET_TABLE,
    scanned,
    would_update_rows: wouldUpdate,
    skipped_both_null: skippedBothNull,
    would_not_found_rows: wouldNotFound,
    reasons: reasonCounts,
    report_path: MISMATCH_REPORT_PATH,
  });
}

async function main() {
  validateDatabaseUrl(PROD_DATABASE_URL);
  const pool = new Pool({ connectionString: PROD_DATABASE_URL });

  if (INSPECT_TABLES) {
    try {
      await inspectTables(pool);
    } finally {
      await pool.end();
    }
    return;
  }

  const users = readUsersFromExport();

  if (DIAGNOSE_MISMATCHES) {
    try {
      await diagnoseMismatches(pool, users);
    } finally {
      await pool.end();
    }
    return;
  }

  let scanned = 0;
  let wouldOrDidUpdate = 0;
  let skipped = 0;
  let notFound = 0;
  let byXId = 0;
  let byHandle = 0;

  try {
    await pool.query("BEGIN");
    for (const user of users) {
      scanned += 1;
      const bio = user?.bio ?? null;
      const accountCreatedAt = user?.account_created_at ?? null;
      const xUserId = user?.x_user_id ?? null;
      const handle = user?.handle ?? null;

      // Never overwrite with null; skip records with no data.
      if (bio === null && accountCreatedAt === null) {
        skipped += 1;
        continue;
      }

      let rowCount = 0;
      if (validXId(xUserId)) {
        rowCount = await updateByXUserId(pool, bio, accountCreatedAt, xUserId);
        if (rowCount > 0) byXId += rowCount;
      }
      if (rowCount === 0 && handle) {
        rowCount = await updateByHandle(pool, bio, accountCreatedAt, handle);
        if (rowCount > 0) byHandle += rowCount;
      }

      if (rowCount > 0) {
        wouldOrDidUpdate += rowCount;
      } else {
        notFound += 1;
      }
    }

    if (DRY_RUN) {
      await pool.query("ROLLBACK");
    } else {
      await pool.query("COMMIT");
    }
  } finally {
    await pool.end();
  }

  console.log("\n[backfill:prod:bios] summary");
  console.log({
    target_table: TARGET_TABLE,
    mode: DRY_RUN ? "dry-run (rolled back)" : "live-run (committed)",
    json_path: JSON_PATH,
    scanned,
    updated_rows: wouldOrDidUpdate,
    updated_by_x_user_id: byXId,
    updated_by_handle: byHandle,
    skipped_both_null: skipped,
    not_found: notFound,
  });
}

main().catch((err) => {
  console.error("[backfill:prod:bios] fatal:", err);
  process.exit(1);
});
