import test from "node:test";
import assert from "node:assert/strict";
import { MAX_CANVAS_DPR, resolveCanvasDpr } from "./canvasDpr.js";

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
