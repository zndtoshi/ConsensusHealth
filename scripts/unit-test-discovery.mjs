#!/usr/bin/env node
/**
 * Deterministic, cross-platform discovery of unit test files.
 * Recurses server/src and src for *.test.{ts,tsx,js,jsx}, excluding *.integration.ts.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

export const UNIT_TEST_ROOTS = ["server/src", "src"];

const TEST_FILE_RE = /\.test\.(ts|tsx|js|jsx)$/i;
const INTEGRATION_FILE_RE = /\.integration\.ts$/i;

/**
 * @param {string} [cwd=process.cwd()]
 * @returns {string[]} POSIX-style paths relative to cwd, sorted.
 */
export function discoverUnitTestFiles(cwd = process.cwd()) {
  /** @type {string[]} */
  const found = [];
  for (const root of UNIT_TEST_ROOTS) {
    walk(join(cwd, root), found, cwd);
  }
  found.sort((a, b) => a.localeCompare(b, "en"));
  return found;
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @param {string} cwd
 */
function walk(dir, out, cwd) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out, cwd);
      continue;
    }
    if (!ent.isFile()) continue;
    if (INTEGRATION_FILE_RE.test(ent.name)) continue;
    if (!TEST_FILE_RE.test(ent.name)) continue;
    out.push(relative(cwd, full).replace(/\\/g, "/"));
  }
}
