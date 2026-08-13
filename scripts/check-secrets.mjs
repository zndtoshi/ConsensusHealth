#!/usr/bin/env node
/**
 * Fail CI/local scans when high-risk secret artifacts or high-entropy tokens
 * appear in tracked OR nonignored untracked files.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BLOCKED_BASENAMES = new Set([
  "cookies.txt",
  "login.json",
  "login2.json",
  "stance.json",
  "delete.json",
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "service-account.json",
]);

const BLOCKED_PATH_RE =
  /(^|\/)(cookies\.txt|login2?\.json|stance\.json|delete\.json|.*\.cookiejar|\.env(\..+)?|credentials\.json|.*secret.*\.(pem|key|json))$/i;

/** Long hex / base64-ish blobs that look like live secrets (not UUIDs alone). */
const HIGH_ENTROPY_RE =
  /(?:(?:api[_-]?key|secret|token|password|authorization)\s*[:=]\s*['"]?)([A-Za-z0-9_\-+/=]{32,})/gi;

/** Docs / lockfiles / media — not secret sinks. Do NOT blanket-exempt .github. */
const ALLOW_PATH_RE =
  /(^|\/)(package-lock\.json|users\.json|.*\.svg|.*\.png|.*\.jpg|public\/data\/|docs\/|.*\.md|scripts\/check-secrets\.mjs|server\/env\.example)$/i;

function listGitFiles(args) {
  try {
    const out = execSync(`git ls-files -z ${args}`, { cwd: ROOT, encoding: "buffer" });
    return out
      .toString("utf8")
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function listScanFiles() {
  const tracked = listGitFiles("");
  if (!tracked) {
    console.error("check-secrets: git ls-files failed");
    process.exit(2);
  }
  const others = listGitFiles("--others --exclude-standard") || [];
  const seen = new Set();
  const files = [];
  for (const f of [...tracked, ...others]) {
    const norm = f.replace(/\\/g, "/");
    if (seen.has(norm)) continue;
    seen.add(norm);
    files.push(norm);
  }
  return { files, trackedCount: tracked.length, untrackedCount: others.length };
}

function basename(p) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

const { files, trackedCount, untrackedCount } = listScanFiles();
const failures = [];

for (const file of files) {
  const base = basename(file);
  if (BLOCKED_BASENAMES.has(base) || BLOCKED_PATH_RE.test(file.replace(/\\/g, "/"))) {
    failures.push(`blocked artifact tracked: ${file}`);
    continue;
  }
  if (ALLOW_PATH_RE.test(file.replace(/\\/g, "/"))) continue;
  if (!/\.(js|jsx|ts|tsx|mjs|cjs|json|yml|yaml|env|txt|html|css)$/i.test(file)) continue;

  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue;
  let text = "";
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  if (text.length > 1_500_000) continue;

  HIGH_ENTROPY_RE.lastIndex = 0;
  let m;
  while ((m = HIGH_ENTROPY_RE.exec(text))) {
    const value = m[1] || "";
    // Skip obvious placeholders / CI fixtures (still scan .github — no blanket exempt).
    if (
      /change_me|your_|example|placeholder|xxxx|TODO|^ci_|_e2e_|at_least_|mock_/i.test(value)
    ) {
      continue;
    }
    if (/^[0-9a-f-]{32,}$/i.test(value) && value.includes("-")) continue; // UUID-like
    failures.push(`${file}: possible secret assignment near "${m[0].slice(0, 48)}…"`);
    break;
  }
}

const TREE_BLOCKED = [
  "cookies.txt",
  "login.json",
  "login2.json",
  "stance.json",
  "delete.json",
];

// Fail if blocked files exist in the tree and are not gitignored (common leak).
for (const name of TREE_BLOCKED) {
  const abs = join(ROOT, name);
  if (!existsSync(abs)) continue;
  let ignored = false;
  try {
    execSync(`git check-ignore -q -- "${name}"`, { cwd: ROOT, stdio: "ignore" });
    ignored = true;
  } catch {
    ignored = false;
  }
  if (!ignored) {
    failures.push(`blocked file present in tree (not gitignored): ${name}`);
  }
}

if (failures.length) {
  console.error("Secret / artifact scan failed:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log(
  `check-secrets: ok (${files.length} files scanned; ${trackedCount} tracked + ${untrackedCount} nonignored untracked)`
);
