import test from "node:test";
import assert from "node:assert/strict";
import { layoutEqualSizeGrid, STANCE, type EqualSizeGridNode } from "./equalSizeGrid.js";

function makeNodes(handles: string[], followers: number[]): EqualSizeGridNode[] {
  return handles.map((handle, i) => ({
    handle,
    seedStance: STANCE.AGAINST,
    followers: followers[i] ?? 0,
    x: 0,
    y: 0,
  }));
}

test("column fill places highest followers down the first column", () => {
  const nodes = makeNodes(["a", "b", "c", "d", "e", "f"], [600, 500, 400, 300, 200, 100]);
  const labels = Object.fromEntries(nodes.map((n) => [n.handle!, STANCE.AGAINST]));
  layoutEqualSizeGrid(nodes, labels, 400, 200, "column");
  const byHandle = Object.fromEntries(nodes.map((n) => [n.handle!, n]));
  assert.ok(byHandle.a!.y < byHandle.b!.y);
  assert.ok(Math.abs(byHandle.a!.x - byHandle.b!.x) < 0.01);
  assert.ok(byHandle.c!.x > byHandle.a!.x);
});

test("row fill places highest followers left-to-right on the first row", () => {
  const nodes = makeNodes(["a", "b", "c", "d", "e", "f"], [600, 500, 400, 300, 200, 100]);
  const labels = Object.fromEntries(nodes.map((n) => [n.handle!, STANCE.AGAINST]));
  layoutEqualSizeGrid(nodes, labels, 400, 200, "row");
  const byHandle = Object.fromEntries(nodes.map((n) => [n.handle!, n]));
  assert.ok(byHandle.a!.x < byHandle.b!.x);
  assert.ok(Math.abs(byHandle.a!.y - byHandle.b!.y) < 0.01);
  assert.ok(byHandle.d!.y > byHandle.a!.y);
});
