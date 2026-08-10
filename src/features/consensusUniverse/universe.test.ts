import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("usePrefersReducedMotion is a callable hook export", () => {
  assert.equal(typeof usePrefersReducedMotion, "function");
});

test("consensus universe chrome module exists as a separate lazy chunk entry", () => {
  const chromePath = path.join(here, "ConsensusUniverseChrome.jsx");
  assert.equal(fs.existsSync(chromePath), true);
  const src = fs.readFileSync(chromePath, "utf8");
  assert.match(src, /GalaxyHeaderNav/);
  assert.match(src, /DistantGalaxies/);
  assert.match(src, /EdgeGalaxyNav/);
  assert.match(src, /GalaxyTravelOverlay/);
});
