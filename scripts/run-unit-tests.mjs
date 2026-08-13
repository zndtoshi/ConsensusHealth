#!/usr/bin/env node
/**
 * Cross-platform unit test launcher: discover files, then run tsx --test with explicit paths.
 */
import { spawnSync } from "node:child_process";
import { discoverUnitTestFiles } from "./unit-test-discovery.mjs";

const files = discoverUnitTestFiles(process.cwd());

if (files.length === 0) {
  console.error("run-unit-tests: discovery returned zero unit test files");
  process.exit(1);
}

console.log(`run-unit-tests: discovered=${files.length}`);

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    shell: false,
  }
);

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
const skipped = parseCount("skipped") ?? parseCount("skip");
const skip = skipped ?? 0;

console.log(
  `run-unit-tests: discovered=${files.length} pass=${pass ?? "?"} fail=${fail ?? "?"} skip=${skip}`
);

if (result.error) {
  console.error("run-unit-tests: failed to spawn", result.error);
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);
