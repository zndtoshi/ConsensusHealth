#!/usr/bin/env node
/**
 * Run Postgres integration tests and fail when every test is skipped
 * (e.g. missing TEST_DATABASE_URL) or when any fail.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const url = String(process.env.TEST_DATABASE_URL || "").trim();
if (!url) {
  console.error("require-integration-passes: TEST_DATABASE_URL is required");
  process.exit(1);
}

const integrationDir = join(process.cwd(), "server", "src", "integration");
let files = [];
try {
  files = readdirSync(integrationDir)
    .filter((name) => name.endsWith(".ts") && name !== "helpers.ts")
    .map((name) => join(integrationDir, name));
} catch (err) {
  console.error("require-integration-passes: cannot read integration dir", err);
  process.exit(1);
}

if (!files.length) {
  console.error("require-integration-passes: no integration test files found");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  shell: false,
});

const out = `${result.stdout || ""}${result.stderr || ""}`;
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

function parseCount(label) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:ℹ\\s*)?${label}\\s+(\\d+)`, "im");
  const m = out.match(re);
  return m ? Number(m[1]) : null;
}

const pass = parseCount("pass");
const fail = parseCount("fail");
const skipped = parseCount("skipped");
const tests = parseCount("tests");

if (result.error) {
  console.error("require-integration-passes: failed to spawn", result.error);
  process.exit(1);
}

if (result.status !== 0 && result.status != null) {
  console.error("require-integration-passes: integration process exited non-zero");
  process.exit(result.status);
}

if (fail != null && fail > 0) {
  console.error(`require-integration-passes: ${fail} failing integration test(s)`);
  process.exit(1);
}

if (skipped != null && skipped > 0) {
  console.error(`require-integration-passes: ${skipped} skipped integration test(s); skips are not allowed`);
  process.exit(1);
}

if ((pass == null || pass === 0) && (tests == null || tests === 0)) {
  console.error(
    "require-integration-passes: expected nonzero passing integration tests (none ran)"
  );
  process.exit(1);
}

if (pass != null && pass === 0) {
  console.error("require-integration-passes: zero passing integration tests");
  process.exit(1);
}

console.log(
  `require-integration-passes: ok (pass=${pass ?? "?"}, fail=${fail ?? 0}, skipped=${skipped ?? 0})`
);
