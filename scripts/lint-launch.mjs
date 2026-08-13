#!/usr/bin/env node
/**
 * Lint/type-check launch/security surfaces including App.jsx.
 * - ESLint: launch-related frontend + scripts + App.jsx (included; not omitted).
 * - tsc: full server TypeScript project (covers every security/OAuth launch module).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: true,
    stdio: "inherit",
  });
  return result.status == null ? 1 : result.status;
}

function walk(dir, pred, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, pred, out);
    } else if (pred(full.replace(/\\/g, "/"))) {
      out.push(full.replace(/\\/g, "/"));
    }
  }
  return out;
}

const eslintTargets = new Set([
  "src/App.jsx",
  "src/components/InfoPages.jsx",
  "src/components/DeleteAccountDialog.jsx",
  "src/components/StanceChoiceCard.jsx",
  "public/auth/popup-complete.js",
  "scripts/check-secrets.mjs",
  "scripts/launch-static-smoke.mjs",
  "scripts/require-integration-passes.mjs",
  "scripts/lint-launch.mjs",
  "scripts/generate-og-card.mjs",
]);

// Launch-related frontend utils (.js/.jsx).
for (const f of walk("src", (p) =>
  /\/(components|utils|api|config)\//.test(p) &&
  /\.(js|jsx)$/.test(p) &&
  /(InfoPages|DeleteAccount|StanceChoice|publicContact|infoPage|distantGalaxy|proposalAbout|community)/i.test(
    p
  )
)) {
  eslintTargets.add(f);
}

for (const f of walk("scripts", (p) => /\.(mjs|js)$/.test(p) && /(launch|secret|integration|og|lint)/i.test(p))) {
  eslintTargets.add(f);
}

for (const f of walk("public/auth", (p) => /\.js$/.test(p))) {
  eslintTargets.add(f);
}

const targets = [...eslintTargets];
const eslintStatus = run("npx", ["eslint", ...targets, "--max-warnings", "0"]);
if (eslintStatus !== 0) process.exit(eslintStatus);

// Server launch/security TypeScript — entire server project (includes oauth*, privacy*, clientIp, etc.).
const tscStatus = run("npx", ["tsc", "-p", "server/tsconfig.json", "--noEmit"]);
process.exit(tscStatus);
