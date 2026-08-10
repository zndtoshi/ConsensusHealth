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

test("mobile header stacks brand, galaxy title, and search without absolute overlap", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");
  assert.match(appSrc, /className="appHeader"/);
  assert.match(appSrc, /appHeader__brand/);
  assert.match(appSrc, /appHeader__search/);
  assert.match(appSrc, /appHeader__center/);
  assert.match(appSrc, /appHeader__controls/);
  assert.match(appSrc, /searchToggleBtn/);
  assert.match(appSrc, /selectedUserCard/);
  assert.match(appSrc, /searchOpen/);
  assert.match(cssSrc, /@media \(max-width: 720px\)/);
  assert.match(cssSrc, /grid-template-areas:/);
  assert.match(cssSrc, /"brand search controls"/);
  assert.match(cssSrc, /\.selectedUserCard\s*\{/);
  assert.match(cssSrc, /\.searchToggleBtn\s*\{/);
  assert.match(cssSrc, /\.galaxyHeaderNav__tooltip\s*\{[\s\S]*display:\s*none/);
  assert.match(cssSrc, /\.galaxyHeaderNav__description\s*\{[\s\S]*display:\s*block/);
});

test("distant proposals render as labeled galaxies flanking the center mass", () => {
  const distantSrc = fs.readFileSync(path.join(here, "DistantGalaxies.jsx"), "utf8");
  const headerSrc = fs.readFileSync(path.join(here, "GalaxyHeaderNav.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");
  assert.match(distantSrc, /sideIndex === 0 \? 9 : 91/);
  assert.match(distantSrc, /distantGalaxy__label/);
  assert.match(distantSrc, /distantGalaxy__arms/);
  assert.match(distantSrc, /distantGalaxy__dust/);
  assert.match(distantSrc, /distantGalaxy__star/);
  assert.match(cssSrc, /\.distantGalaxy__arms/);
  assert.match(cssSrc, /\.distantGalaxy__dust/);
  assert.match(cssSrc, /\.distantGalaxy__star/);
  assert.match(cssSrc, /conic-gradient/);
  assert.doesNotMatch(cssSrc, /\.edgeGalaxyNav\b/);
  assert.match(headerSrc, /galaxyHeaderNav__description/);
  assert.match(headerSrc, /galaxyHeaderNav__github/);
  assert.match(headerSrc, /proposalGithubUrl/);
  assert.match(headerSrc, /current\.description/);
  assert.match(cssSrc, /\.galaxyHeaderNav__github/);
  assert.match(cssSrc, /\.galaxyHeaderNav__tooltip/);
});
