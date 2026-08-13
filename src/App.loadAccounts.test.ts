import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");

test("loadAccounts production path refuses seed fallback when community API fails", () => {
  assert.match(appSrc, /import\.meta\.env\.PROD/);
  assert.match(appSrc, /community_unavailable/);
  assert.match(appSrc, /privacy suppressions|bypasses privacy/i);
  // Dev fixture path remains for non-PROD.
  assert.match(appSrc, /Dev-only fixture fallback/);
  assert.doesNotMatch(
    appSrc,
    /else \{\s*for \(const a of Array\.isArray\(seeded\)[\s\S]*?upsert\(a, "seeded"\);[\s\S]*?\}\s*finalizeMerged/
  );
});

test("maintenance errBox does not render raw err string to users", () => {
  assert.match(appSrc, /Consensus Health is having trouble loading/);
  assert.match(appSrc, /errRequestId/);
  assert.match(appSrc, /Reference:/);
  // Must not dump `{err}` into the alert body.
  assert.doesNotMatch(appSrc, /marginBottom: 12 \}>\{err\}<\/div>/);
});
