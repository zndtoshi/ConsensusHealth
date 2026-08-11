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
  assert.match(appSrc, /galaxyEmptyState/);
  assert.match(appSrc, /isPrivilegedManualEditor\(me\?\.handle\)/);
  assert.match(appSrc, /proposalAccessReady/);
  assert.doesNotMatch(appSrc, /from "\.\/components\/GalaxyHeaderNav"/);
  assert.doesNotMatch(appSrc, /ArrowLeft/);
  assert.doesNotMatch(appSrc, /ArrowRight/);
  assert.doesNotMatch(appSrc, /getAdjacent/);
  assert.match(appSrc, /proposalCatalogReady && proposalCatalog\.filter/);
  assert.match(appSrc, /:\s*700/);
});

test("brand area no longer keeps a legacy BIP-110 badge link", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.doesNotMatch(appSrc, /className="bipTagLink"/);
  assert.doesNotMatch(appSrc, /title="View the official BIP-110 proposal on GitHub"/);
});

test("selected avatar card has no close X button", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");
  assert.match(appSrc, /selectedUserCard/);
  assert.match(appSrc, /selectedUserCard__avatar/);
  assert.match(appSrc, /selectedUserCard__handle/);
  assert.match(appSrc, /selectedUserCard__stance/);
  assert.doesNotMatch(appSrc, /selectedUserCard__close/);
  assert.doesNotMatch(appSrc, /Clear selected user/);
  assert.doesNotMatch(cssSrc, /\.selectedUserCard__close\b/);
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

test("header BIP nav is a centered dropdown without prev/next controls", () => {
  const headerSrc = fs.readFileSync(path.join(here, "GalaxyHeaderNav.jsx"), "utf8");
  assert.match(headerSrc, /role="listbox"/);
  assert.match(headerSrc, /aria-haspopup="listbox"/);
  assert.match(headerSrc, /galaxyHeaderNav__trigger/);
  assert.match(headerSrc, /galaxyHeaderNav__chevron/);
  assert.match(headerSrc, /galaxyHeaderNav__option/);
  assert.match(headerSrc, /galaxyHeaderNav__descRow/);
  assert.match(headerSrc, /visualTheme\?\.accent/);
  assert.doesNotMatch(headerSrc, /p\.id === "bip110"/);
  assert.match(headerSrc, /Final snapshot/);
  assert.match(headerSrc, /Ongoing/);
  assert.match(headerSrc, /Escape/);
  assert.match(headerSrc, /triggerRef/);
  assert.match(headerSrc, /restoreFocusAfterTravelRef/);
  assert.match(headerSrc, /Do not intercept Tab/);
  assert.doesNotMatch(headerSrc, /galaxyHeaderNav__side/);
  assert.doesNotMatch(headerSrc, /getAdjacent/);
  assert.doesNotMatch(headerSrc, /\bPrev\b|\bNext\b/);
  assert.doesNotMatch(headerSrc, /e\.key === "Tab"[\s\S]{0,80}preventDefault/);
  assert.doesNotMatch(headerSrc, /position:\s*absolute/);
});

test("distant galaxies are interactive travel shortcuts with capped neighbors", () => {
  const distantSrc = fs.readFileSync(path.join(here, "DistantGalaxies.jsx"), "utf8");
  const headerSrc = fs.readFileSync(path.join(here, "GalaxyHeaderNav.jsx"), "utf8");
  const chromeSrc = fs.readFileSync(
    path.join(here, "..", "features", "consensusUniverse", "ConsensusUniverseChrome.jsx"),
    "utf8"
  );
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");
  assert.match(distantSrc, /selectDistantProposals/);
  assert.match(distantSrc, /onNavigate/);
  assert.match(distantSrc, /<button/);
  assert.match(distantSrc, /aria-label/);
  assert.match(distantSrc, /Travel to/);
  assert.doesNotMatch(distantSrc, /Travel affordance|Travel »/);
  assert.match(distantSrc, /distantGalaxy__label/);
  assert.match(cssSrc, /\.distantGalaxy:hover/);
  assert.match(cssSrc, /scale\(calc\(var\(--galaxy-scale, 1\) \* 1\.08\)\)/);
  assert.match(cssSrc, /--gx-par-fx/);
  assert.match(appSrc, /defaultAccountFilterActive/);
  assert.match(appSrc, /showDistantGalaxies=\{defaultAccountFilterActive\}/);
  assert.match(appSrc, /statsActionLabel/);
  assert.match(appSrc, /statsModalCopy/);
  assert.match(appSrc, /statsForProposalId/);
  assert.match(chromeSrc, /onNavigate=\{onNavigate\}/);
  assert.match(headerSrc, /galaxyHeaderNav__github/);
  assert.match(headerSrc, /galaxyHeaderNav__descRow/);
});
