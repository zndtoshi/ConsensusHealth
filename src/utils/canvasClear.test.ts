import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCanvasBitmap, cssPixelClearWouldMissBitmap } from "./canvasClear.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");

test("identity transform CSS clear misses HiDPI bitmap (Chrome trail mode)", () => {
  assert.equal(
    cssPixelClearWouldMissBitmap({
      canvasWidth: 2000,
      canvasHeight: 1200,
      clearWidthCss: 1000,
      clearHeightCss: 600,
      transformA: 1,
      transformD: 1,
    }),
    true
  );
});

test("DPR transform CSS clear covers full bitmap", () => {
  assert.equal(
    cssPixelClearWouldMissBitmap({
      canvasWidth: 2000,
      canvasHeight: 1200,
      clearWidthCss: 1000,
      clearHeightCss: 600,
      transformA: 2,
      transformD: 2,
    }),
    false
  );
});

test("world-scale leftover transform can miss the bitmap", () => {
  assert.equal(
    cssPixelClearWouldMissBitmap({
      canvasWidth: 2000,
      canvasHeight: 1200,
      clearWidthCss: 1000,
      clearHeightCss: 600,
      transformA: 0.4,
      transformD: 0.4,
    }),
    true
  );
});

test("clearCanvasBitmap resets transform/alpha and clears device pixels", () => {
  const calls = [];
  const ctx = {
    globalAlpha: 0.25,
    globalCompositeOperation: "lighter",
    save() {
      calls.push("save");
    },
    restore() {
      calls.push("restore");
    },
    setTransform(...args) {
      calls.push(["setTransform", ...args]);
    },
    clearRect(...args) {
      calls.push(["clearRect", ...args]);
    },
  };
  clearCanvasBitmap(ctx, { width: 1800, height: 900 });
  assert.deepEqual(calls[0], "save");
  assert.deepEqual(calls[1], ["setTransform", 1, 0, 0, 1, 0, 0]);
  assert.equal(ctx.globalAlpha, 1);
  assert.equal(ctx.globalCompositeOperation, "source-over");
  assert.deepEqual(calls[2], ["clearRect", 0, 0, 1800, 900]);
  assert.deepEqual(calls[3], "restore");
});

test("App draw path uses clearCanvasBitmap before painting", () => {
  assert.match(appSrc, /clearCanvasBitmap/);
  assert.match(appSrc, /from ["'].*canvasClear["']/);
  // Must not rely solely on CSS-pixel clearRect under an ambient transform.
  assert.match(
    appSrc,
    /clearCanvasBitmap\(ctx,\s*canvas\)[\s\S]{0,120}setTransform\(dpr/
  );
});

test("filter transitions freeze cluster halos while active", () => {
  assert.match(appSrc, /filterTransitionRef/);
  assert.match(appSrc, /haloFrozen/);
  assert.match(appSrc, /freeze:\s*true/);
  assert.match(appSrc, /filterMotionActive/);
});
