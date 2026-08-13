import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("E2E builds a production browser bundle while the backend remains in strict test mode", () => {
  const playwrightConfig = readFileSync(join(root, "playwright.config.ts"), "utf8");
  const buildScript = readFileSync(join(root, "scripts", "build-web-for-e2e.mjs"), "utf8");

  assert.match(playwrightConfig, /node scripts\/build-web-for-e2e\.mjs/);
  assert.match(playwrightConfig, /NODE_ENV:\s*"test"/);
  assert.match(buildScript, /NODE_ENV:\s*"production"/);
  assert.match(buildScript, /node_modules\/vite\/bin\/vite\.js/);
});
