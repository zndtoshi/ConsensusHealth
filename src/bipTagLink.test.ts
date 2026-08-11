import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(srcDir, "App.jsx"), "utf8");
const cssSrc = readFileSync(join(srcDir, "index.css"), "utf8");
const headerSrc = readFileSync(join(srcDir, "components", "GalaxyHeaderNav.jsx"), "utf8");

test("legacy top-left BIP-110 brand link is removed", () => {
  assert.doesNotMatch(appSrc, /className="bipTagLink"/);
  assert.doesNotMatch(appSrc, /title="View the official BIP-110 proposal on GitHub"/);
  assert.doesNotMatch(appSrc, /aria-label="Open official BIP-110 proposal on GitHub"/);
  assert.doesNotMatch(cssSrc, /\.bipTagLink\b/);
});

test("centered BIP selector keeps the official proposal GitHub link", () => {
  assert.match(headerSrc, /galaxyHeaderNav__github/);
  assert.match(headerSrc, /proposalGithubUrl/);
  assert.match(headerSrc, /Open the official \$\{current\.shortName\} proposal on GitHub/);
});
