import test from "node:test";
import assert from "node:assert/strict";
import {
  projectDirect,
  projectViaBlit,
  zoomBlitFactor,
  zoomBlitTransform,
} from "./zoomBlitTransform.js";

const FIT = { scale: 1.4, tx: 37, ty: -12 };
const DPR = 2;

/**
 * The whole point of the fast path: resampling the snapshot must put world
 * points exactly where a real render would. Any drift here would show as the
 * graph sliding or jumping while zooming.
 */
function assertMatchesRealRender(layer, cam, worldPoints) {
  const k = zoomBlitFactor(layer.scaleMul, cam.scaleMul, 0.8, 1.8);
  assert.ok(k !== null, "expected the snapshot to be usable");
  const t = zoomBlitTransform(FIT.tx, FIT.ty, layer, cam, k, DPR);
  for (const p of worldPoints) {
    const viaBlit = projectViaBlit(p, FIT.scale, FIT.tx, layer.panX, layer.scaleMul, t, "x", DPR);
    const direct = projectDirect(p, FIT.scale, FIT.tx, cam.panX, cam.scaleMul, DPR);
    assert.ok(
      Math.abs(viaBlit - direct) < 1e-9,
      `x mismatch at world ${p}: blit ${viaBlit} vs render ${direct}`
    );
    const viaBlitY = projectViaBlit(p, FIT.scale, FIT.ty, layer.panY, layer.scaleMul, t, "y", DPR);
    const directY = projectDirect(p, FIT.scale, FIT.ty, cam.panY, cam.scaleMul, DPR);
    assert.ok(
      Math.abs(viaBlitY - directY) < 1e-9,
      `y mismatch at world ${p}: blit ${viaBlitY} vs render ${directY}`
    );
  }
}

const POINTS = [-450, -60, 0, 17.5, 320, 980];

test("zoom blit matches a real render when zooming in", () => {
  assertMatchesRealRender(
    { scaleMul: 1, panX: 20, panY: -8 },
    { scaleMul: 1.55, panX: -140, panY: 96 },
    POINTS
  );
});

test("zoom blit matches a real render when zooming out", () => {
  assertMatchesRealRender(
    { scaleMul: 2.2, panX: -300, panY: 40 },
    { scaleMul: 1.9, panX: -60, panY: -25 },
    POINTS
  );
});

test("pure panning degenerates to the original translation-only blit", () => {
  const layer = { scaleMul: 1.3, panX: 10, panY: 5 };
  const cam = { scaleMul: 1.3, panX: 85, panY: -40 };
  const k = zoomBlitFactor(layer.scaleMul, cam.scaleMul, 0.8, 1.8);
  assert.equal(k, 1);
  const t = zoomBlitTransform(FIT.tx, FIT.ty, layer, cam, k, DPR);
  // Old fast-pan path drew the bitmap at (dx*dpr, dy*dpr) with no scaling.
  assert.equal(t.k, 1);
  assert.ok(Math.abs(t.tXDev - (cam.panX - layer.panX) * DPR) < 1e-9);
  assert.ok(Math.abs(t.tYDev - (cam.panY - layer.panY) * DPR) < 1e-9);
});

test("snapshot is rejected once the zoom drifts outside the usable range", () => {
  // Too far in: the bitmap would visibly soften.
  assert.equal(zoomBlitFactor(1, 2.4, 0.8, 1.8), null);
  // Too far out: the snapshot no longer covers the viewport edges.
  assert.equal(zoomBlitFactor(2, 1.2, 0.8, 1.8), null);
  // Just inside both bounds.
  assert.equal(zoomBlitFactor(1, 1.8, 0.8, 1.8), 1.8);
  assert.equal(zoomBlitFactor(1, 0.8, 0.8, 1.8), 0.8);
});

test("degenerate scales are rejected rather than producing NaN transforms", () => {
  assert.equal(zoomBlitFactor(0, 1, 0.8, 1.8), null);
  assert.equal(zoomBlitFactor(1, 0, 0.8, 1.8), null);
  assert.equal(zoomBlitFactor(Number.NaN, 1, 0.8, 1.8), null);
});
