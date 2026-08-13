import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CANVAS_DPR, resolveCanvasDpr, syncWrapperCanvas } from "./canvasDpr.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("resolveCanvasDpr caps above MAX_CANVAS_DPR", () => {
  assert.equal(resolveCanvasDpr(3), MAX_CANVAS_DPR);
  assert.equal(resolveCanvasDpr(2.5), MAX_CANVAS_DPR);
});

test("resolveCanvasDpr preserves values at or below the cap", () => {
  assert.equal(resolveCanvasDpr(1), 1);
  assert.equal(resolveCanvasDpr(1.5), 1.5);
  assert.equal(resolveCanvasDpr(2), 2);
});

test("resolveCanvasDpr handles invalid input", () => {
  assert.equal(resolveCanvasDpr(0), 1);
  assert.equal(resolveCanvasDpr(Number.NaN), 1);
  assert.equal(resolveCanvasDpr(-1), 1);
});

test("syncWrapperCanvas matches wrapper CSS and DPR-scaled bitmap", () => {
  const canvas = { width: 300, height: 150, style: { width: "", height: "" } };
  const sized = syncWrapperCanvas(canvas, 1280, 659.2, 1.25);
  assert.equal(sized.cssW, 1280);
  assert.equal(sized.cssH, 659);
  assert.equal(sized.bitmapW, 1600);
  assert.equal(sized.bitmapH, 823);
  assert.equal(sized.changed, true);
  assert.equal(canvas.width, 1600);
  assert.equal(canvas.height, 823);
  assert.equal(canvas.style.width, "1280px");
  assert.equal(canvas.style.height, "659px");

  const again = syncWrapperCanvas(canvas, 1280, 659, 1.25);
  assert.equal(again.changed, false);
});

test("App sizes main and intro wrapper canvases with syncWrapperCanvas", () => {
  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
  assert.match(appSrc, /syncWrapperCanvas\(canvas,\s*cw,\s*ch,\s*dpr\)/);
  assert.match(appSrc, /syncWrapperCanvas\(introCanvas,\s*cw,\s*ch,\s*dpr\)/);
  assert.match(appSrc, /setCanvasWrapRef/);
  assert.doesNotMatch(appSrc, /ref=\{\(el\)\s*=>\s*\{\s*setContainerEl\(el\);/);
});
