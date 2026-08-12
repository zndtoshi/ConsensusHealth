import test from "node:test";
import assert from "node:assert/strict";
import {
  applySparseFitCap,
  sparseMaxOnScreenAvatarPx,
  sparseSelectedTargetSide,
} from "./sparseFitCap";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("sparse max on-screen avatar shrinks for 1–4 nodes and relaxes by 10+", () => {
  const desktop = 900;
  const mobile = 390;
  const oneD = sparseMaxOnScreenAvatarPx(1, desktop);
  const fewD = sparseMaxOnScreenAvatarPx(3, desktop);
  const midD = sparseMaxOnScreenAvatarPx(7, desktop);
  const denseD = sparseMaxOnScreenAvatarPx(40, desktop);
  assert.ok(oneD >= 120 && oneD <= 160);
  assert.ok(fewD >= 100 && fewD <= 140);
  assert.ok(fewD < oneD);
  assert.ok(midD > fewD);
  assert.ok(denseD > midD);

  const oneM = sparseMaxOnScreenAvatarPx(1, mobile);
  assert.ok(oneM < oneD);
  assert.ok(oneM >= 100 && oneM <= 130);
});

test("applySparseFitCap binds sparse galaxies but not dense ones", () => {
  const maxSide = 70;
  // Uncapped fit that would make a 70px world avatar ~500px on screen.
  const hugeFit = 500 / maxSide;
  const sparse = applySparseFitCap({
    fitScale: hugeFit,
    maxNodeSide: maxSide,
    visibleNodeCount: 1,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.ok(sparse < hugeFit);
  assert.ok(maxSide * sparse <= 160);

  const dense = applySparseFitCap({
    fitScale: hugeFit,
    maxNodeSide: maxSide,
    visibleNodeCount: 80,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  // Dense target is large; with this viewport the "uncapped" soft target may
  // still slightly bind extreme fits, but must stay well above sparse.
  assert.ok(dense > sparse);
  assert.ok(maxSide * dense > 200);

  const untouched = applySparseFitCap({
    fitScale: 1.2,
    maxNodeSide: maxSide,
    visibleNodeCount: 1,
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.equal(untouched, 1.2);
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
  assert.ok(target * fit <= 160 * 1.2);
});

test("App draw path applies sparse fit cap", () => {
  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
  assert.match(appSrc, /applySparseFitCap/);
  assert.match(appSrc, /sparseSelectedTargetSide/);
  assert.match(appSrc, /from "\.\/utils\/sparseFitCap"/);
});
