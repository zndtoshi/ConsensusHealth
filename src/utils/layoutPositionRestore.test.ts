import test from "node:test";
import assert from "node:assert/strict";
import { layoutRestoreIsSufficient } from "./layoutPositionRestore.js";

test("layout restore threshold treats near-full overlap as a hit", () => {
  // Join-date filter dropping ~8 of 724 unknowns should still reuse positions.
  assert.equal(layoutRestoreIsSufficient(716, 716), true);
  assert.equal(layoutRestoreIsSufficient(724, 716), true);
  assert.equal(layoutRestoreIsSufficient(100, 79), false);
  assert.equal(layoutRestoreIsSufficient(100, 80), true);
  assert.equal(layoutRestoreIsSufficient(0, 0), false);
});
