import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cardSrc = readFileSync(join(root, "src", "components", "StanceChoiceCard.jsx"), "utf8");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
const cssSrc = readFileSync(join(root, "src", "index.css"), "utf8");
const serverSrc = readFileSync(join(root, "server", "src", "index.ts"), "utf8");

test("stance choice card buttons use STANCE_COLORS for text", () => {
  assert.match(cardSrc, /style=\{\{ color: STANCE_COLORS\[choice\.ui\] \}\}/);
  assert.match(cardSrc, /Against|STANCE_LABELS/);
});

test("card visual tone reuses new-stances-like glass panel classes", () => {
  assert.match(cssSrc, /\.stanceChoiceCard\s*\{/);
  assert.match(cssSrc, /backdrop-filter:\s*blur\(34px\)/);
  assert.match(cssSrc, /rgba\(239,\s*68,\s*68/);
  assert.match(cssSrc, /rgba\(34,\s*197,\s*94/);
});

test("App presents BIP-110 as a locked final snapshot", () => {
  assert.doesNotMatch(appSrc, /archiveBanner/);
  assert.doesNotMatch(appSrc, /FINAL SNAPSHOT/);
  assert.match(appSrc, /meHasStance && meStanceToolbar/);
  assert.match(appSrc, /Your recorded.*BIP-110.*position/);
  assert.doesNotMatch(appSrc, /onClick=\{\(\) => setStanceChoiceOpen/);
});

test("BIP-110 concluded copy lives in the galaxy header hover tooltip", () => {
  const headerSrc = readFileSync(join(root, "src", "components", "GalaxyHeaderNav.jsx"), "utf8");
  assert.match(headerSrc, /Concluded without consensus/);
  assert.match(headerSrc, /galaxyHeaderNav__tooltip/);
});

test("self-service writes are restricted while admin stance editing remains available", () => {
  const userRoute = serverSrc.indexOf('app.post("/api/stance"');
  const adminRoute = serverSrc.indexOf('app.post("/api/admin/stance"');
  assert.ok(userRoute >= 0);
  assert.ok(adminRoute >= 0);
  assert.match(serverSrc.slice(userRoute, userRoute + 400), /status\(409\)/);
  assert.match(serverSrc.slice(userRoute, userRoute + 400), /stance_updates_restricted/);
  assert.doesNotMatch(serverSrc.slice(adminRoute, adminRoute + 400), /status\(409\)/);
  assert.match(serverSrc.slice(adminRoute, adminRoute + 700), /isPrivilegedManualEditorHandle/);
  assert.match(appSrc, /Set user position/);
  assert.match(appSrc, /Edit positions on graph/);
});

test("admin can choose their own position only outside frozen BIP-110", () => {
  const adminRoute = serverSrc.indexOf('app.post("/api/admin/stance"');
  const routeSrc = serverSrc.slice(adminRoute, adminRoute + 2200);
  assert.match(routeSrc, /editingSelf/);
  assert.match(routeSrc, /access\.proposalId === DEFAULT_PROPOSAL_ID/);
  assert.match(routeSrc, /bip110_stances_frozen/);
  assert.match(appSrc, /activeProposalId !== DEFAULT_PROPOSAL_ID/);
  assert.match(appSrc, /openOwnStanceChoice/);
  assert.match(appSrc, /Choose your position/);
  assert.match(appSrc, /allowAbsentFromGalaxy/);
});
