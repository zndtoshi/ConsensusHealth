import test from "node:test";
import assert from "node:assert/strict";
import {
  applySparseFitCap,
  sparseEffectiveAvatarPx,
  sparseGlowFootprintMultiplier,
  sparseMaxOnScreenAvatarPx,
  sparseSelectedTargetSide,
} from "./sparseFitCap";
import { fitTranslationForBounds } from "./galaxyViewport.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("sparse max on-screen avatar stays modest for 1–4 users", () => {
  const desktop = 1000; // ~1920×1000 short side
  const mobile = 390;
  const oneD = sparseMaxOnScreenAvatarPx(1, desktop);
  const twoD = sparseMaxOnScreenAvatarPx(2, desktop);
  const fourD = sparseMaxOnScreenAvatarPx(4, desktop);
  const midD = sparseMaxOnScreenAvatarPx(7, desktop);
  const denseD = sparseMaxOnScreenAvatarPx(40, desktop);
  assert.ok(oneD >= 64 && oneD <= 90, `one-user desktop cap ${oneD}`);
  assert.ok(twoD <= oneD);
  assert.ok(fourD <= 90);
  assert.ok(fourD < midD);
  assert.ok(denseD > midD);

  const oneM = sparseMaxOnScreenAvatarPx(1, mobile);
  assert.ok(oneM < oneD);
  assert.ok(oneM >= 48 && oneM <= 70);
});

test("applySparseFitCap binds one/two/four-user galaxies after load-scale fits", () => {
  const maxSide = 70;
  const hugeFit = 500 / maxSide;
  for (const count of [1, 2, 4]) {
    const sparse = applySparseFitCap({
      fitScale: hugeFit,
      maxNodeSide: maxSide,
      visibleNodeCount: count,
      viewportWidth: 1920,
      viewportHeight: 1000,
    });
    assert.ok(sparse < hugeFit);
    assert.ok(maxSide * sparse <= 90, `count=${count} screen=${maxSide * sparse}`);
  }

  const dense = applySparseFitCap({
    fitScale: hugeFit,
    maxNodeSide: maxSide,
    visibleNodeCount: 80,
    viewportWidth: 1920,
    viewportHeight: 1000,
  });
  assert.ok(dense > applySparseFitCap({
    fitScale: hugeFit,
    maxNodeSide: maxSide,
    visibleNodeCount: 1,
    viewportWidth: 1920,
    viewportHeight: 1000,
  }));

  const untouched = applySparseFitCap({
    fitScale: 0.8,
    maxNodeSide: maxSide,
    visibleNodeCount: 1,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  assert.equal(untouched, 0.8);
});

test("sparse glow footprint shrinks for one/few-user scenes", () => {
  assert.ok(sparseGlowFootprintMultiplier(1) < 0.4);
  assert.ok(sparseGlowFootprintMultiplier(3) < 0.5);
  assert.ok(sparseGlowFootprintMultiplier(20) === 1);
});

test("sparse selected target stays bounded versus default 70 world units", () => {
  const fit = applySparseFitCap({
    fitScale: 10,
    maxNodeSide: 70,
    visibleNodeCount: 1,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  const target = sparseSelectedTargetSide(1, 800, fit, 70);
  assert.ok(target <= 70);
  assert.ok(target * fit <= 90 * 1.2);
});

test("App draw path applies sparse fit cap and glow footprint", () => {
  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
  assert.match(appSrc, /applySparseFitCap/);
  assert.match(appSrc, /userScaleMul/);
  assert.match(appSrc, /sparseSelectedTargetSide/);
  assert.match(appSrc, /sparseGlowFootprintMultiplier/);
  assert.match(appSrc, /padMultiplier:\s*sparseGlowMul/);
  assert.match(appSrc, /from "\.\/utils\/sparseFitCap"/);
});

test("effective scale with non-1 camera multiplier stays under sparse cap for 1/2/4 users", () => {
  const maxSide = 70;
  const hugeFit = 12;
  const userScaleMul = 2.4;
  for (const count of [1, 2, 4]) {
    const fit = applySparseFitCap({
      fitScale: hugeFit,
      maxNodeSide: maxSide,
      visibleNodeCount: count,
      viewportWidth: 1920,
      viewportHeight: 1000,
      userScaleMul,
    });
    const screenPx = sparseEffectiveAvatarPx(maxSide, fit, userScaleMul);
    const cap = sparseMaxOnScreenAvatarPx(count, 1000);
    assert.ok(screenPx <= cap + 1e-6, `count=${count} screen=${screenPx} cap=${cap}`);
    assert.ok(fit < hugeFit);
  }
});

test("empty-to-one account insertion and resize/reset keep effective cap", () => {
  const maxSide = 70;
  const userScaleMul = 1.75;
  // Geometric fit before the first voter is inserted (would be huge alone).
  const preVoteFit = 20;

  // First voter lands in an empty proposal — cap applies on that same frame.
  const afterVote = applySparseFitCap({
    fitScale: preVoteFit,
    maxNodeSide: maxSide,
    visibleNodeCount: 1,
    viewportWidth: 1280,
    viewportHeight: 659,
    userScaleMul,
  });
  assert.ok(afterVote < preVoteFit);
  const afterPx = sparseEffectiveAvatarPx(maxSide, afterVote, userScaleMul);
  assert.ok(afterPx <= sparseMaxOnScreenAvatarPx(1, 659) + 1e-6);

  // Resize / camera-reset recompute at a larger desktop viewport.
  const resized = applySparseFitCap({
    fitScale: preVoteFit,
    maxNodeSide: maxSide,
    visibleNodeCount: 1,
    viewportWidth: 1920,
    viewportHeight: 1000,
    userScaleMul: 1,
  });
  assert.ok(sparseEffectiveAvatarPx(maxSide, resized, 1) <= sparseMaxOnScreenAvatarPx(1, 1000) + 1e-6);

  // Cap adjusts fitScale before translation so centering stays stable.
  const { fitTx, fitTy } = fitTranslationForBounds({
    minX: 0,
    minY: 0,
    maxX: 70,
    maxY: 70,
    cw: 1280,
    ch: 659,
    fitScale: afterVote,
  });
  const cx = 35 * afterVote + fitTx;
  const cy = 35 * afterVote + fitTy;
  assert.ok(Math.abs(cx - 640) < 0.5);
  assert.ok(Math.abs(cy - 659 / 2) < 0.5);
});
