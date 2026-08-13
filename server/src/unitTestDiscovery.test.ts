import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("discoverUnitTestFiles includes root, one-level, and deeper tests", async () => {
  const { discoverUnitTestFiles } = await import("../../scripts/unit-test-discovery.mjs");
  const files = discoverUnitTestFiles(repoRoot);
  assert.ok(files.length > 0, "expected nonzero discovery");

  // Root-level under server/src and src
  assert.ok(files.includes("server/src/proposals.test.ts"), "root server test");
  assert.ok(files.includes("src/bipTagLink.test.ts"), "root src test");

  // One level nested
  assert.ok(files.includes("server/src/security/clientIp.test.ts"), "one-level server test");
  assert.ok(files.includes("src/utils/canvasClear.test.ts"), "one-level src test");

  // Deeper nesting
  assert.ok(
    files.includes("src/features/consensusUniverse/universe.test.ts"),
    "deeper nested test"
  );
});

test("discoverUnitTestFiles excludes integration files and sorts deterministically", async () => {
  const { discoverUnitTestFiles } = await import("../../scripts/unit-test-discovery.mjs");
  const files = discoverUnitTestFiles(repoRoot);

  const integrationHits = files.filter(
    (f: string) => f.includes(".integration.") || f.endsWith(".integration.ts")
  );
  assert.deepEqual(integrationHits, [], "integration files must be excluded");

  assert.ok(
    !files.includes("server/src/integration/oauthState.integration.ts"),
    "known integration file must not appear"
  );

  const sorted = [...files].sort((a, b) => a.localeCompare(b, "en"));
  assert.deepEqual(files, sorted, "discovery order must be sorted");
});
