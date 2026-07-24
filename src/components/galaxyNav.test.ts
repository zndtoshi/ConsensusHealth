import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("admin galaxy UI is gated behind privileged editor check in App", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /adminGalaxiesEnabled/);
  assert.match(appSrc, /GalaxyHeaderNav/);
  assert.match(appSrc, /DistantGalaxies/);
  assert.match(appSrc, /EdgeGalaxyNav/);
  assert.match(appSrc, /travelToGalaxy/);
  assert.match(appSrc, /ArrowLeft/);
  assert.match(appSrc, /galaxyEmptyState/);
  assert.match(appSrc, /isPrivilegedManualEditor\(me\?\.handle\)/);
});

test("non-admin path keeps BIP-110 badge link", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /bip-0110\.mediawiki/);
  assert.match(appSrc, /title="View the official BIP-110 proposal on GitHub"/);
});
