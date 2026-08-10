import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("admin galaxy UI is lazy-loaded behind privileged multi-proposal catalog", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /adminGalaxiesEnabled/);
  assert.match(appSrc, /ConsensusUniverseChrome/);
  assert.match(appSrc, /lazy\(\(\) =>\s*\n\s*import\("\.\/features\/consensusUniverse\/ConsensusUniverseChrome"\)/);
  assert.match(appSrc, /travelToGalaxy/);
  assert.match(appSrc, /ArrowLeft/);
  assert.match(appSrc, /galaxyEmptyState/);
  assert.match(appSrc, /isPrivilegedManualEditor\(me\?\.handle\)/);
  assert.match(appSrc, /proposalAccessReady/);
  assert.doesNotMatch(appSrc, /from "\.\/components\/GalaxyHeaderNav"/);
});

test("non-admin path keeps BIP-110 badge link", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /bip-0110\.mediawiki/);
  assert.match(appSrc, /title="View the official BIP-110 proposal on GitHub"/);
});

test("distant proposals render as labeled galaxies flanking the center mass", () => {
  const distantSrc = fs.readFileSync(path.join(here, "DistantGalaxies.jsx"), "utf8");
  const headerSrc = fs.readFileSync(path.join(here, "GalaxyHeaderNav.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");
  assert.match(distantSrc, /sideIndex === 0 \? 14 : 86/);
  assert.match(distantSrc, /distantGalaxy__label/);
  assert.match(distantSrc, /distantGalaxy__arms/);
  assert.match(cssSrc, /\.distantGalaxy__arms/);
  assert.match(cssSrc, /conic-gradient/);
  assert.match(headerSrc, /galaxyHeaderNav__description/);
  assert.match(headerSrc, /current\.description/);
});
