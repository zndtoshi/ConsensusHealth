import test from "node:test";
import assert from "node:assert/strict";
import { CLUSTER_HALO_ADMIN_HANDLE } from "../config/clusterHalo.js";
import {
  computeClusterBounds,
  computeClusterHaloRadius,
  clusterHaloBreathAlpha,
  shouldShowClusterHalo,
  snapClusterHaloState,
} from "./clusterHalo.js";

test("shouldShowClusterHalo is false for public when flag is off", () => {
  assert.equal(
    shouldShowClusterHalo({ enabled: false, authenticatedHandle: "alice" }),
    false
  );
});

test("shouldShowClusterHalo is true for admin handle when flag is off", () => {
  assert.equal(
    shouldShowClusterHalo({ enabled: false, authenticatedHandle: CLUSTER_HALO_ADMIN_HANDLE }),
    true
  );
  assert.equal(
    shouldShowClusterHalo({ enabled: false, authenticatedHandle: "@zndtoshi" }),
    true
  );
});

test("shouldShowClusterHalo is true for everyone when flag is on", () => {
  assert.equal(shouldShowClusterHalo({ enabled: true, authenticatedHandle: null }), true);
});

test("computeClusterBounds returns cluster center and span", () => {
  const nodes = [
    { x: 10, y: 20, side: 20 },
    { x: 30, y: 40, side: 20 },
    { x: 200, y: 200, side: 20 },
  ];
  const bounds = computeClusterBounds(nodes, "against", (n) => (n.x < 100 ? "against" : "approve"));
  assert.ok(bounds);
  assert.equal(bounds!.cx, 20);
  assert.equal(bounds!.cy, 30);
  assert.equal(bounds!.width, 40);
  assert.equal(bounds!.height, 40);
});

test("computeClusterHaloRadius scales with cluster span", () => {
  const r = computeClusterHaloRadius({ cx: 0, cy: 0, width: 100, height: 80 });
  assert.ok(r > 50 && r < 70);
});

test("snapClusterHaloState aligns halo centers to cluster bounds", () => {
  const nodes = [
    { x: 10, y: 20, side: 20 },
    { x: 30, y: 40, side: 20 },
    { x: 200, y: 200, side: 20 },
  ];
  const snapped = snapClusterHaloState(nodes, (n) => (n.x < 100 ? "against" : "approve"));
  assert.equal(snapped.against?.cx, 20);
  assert.equal(snapped.against?.cy, 30);
  assert.ok(snapped.against!.radius > 0);
  assert.equal(snapped.approve?.cx, 200);
});

test("clusterHaloBreathAlpha oscillates between 0.92 and 1", () => {
  const samples = [0, 1950, 3900, 5850, 7800].map((t) => clusterHaloBreathAlpha("against", t));
  for (const a of samples) {
    assert.ok(a >= 0.919 && a <= 1.001);
  }
  assert.ok(Math.abs(samples[0] - 0.96) < 0.02);
  assert.ok(Math.abs(samples[2] - 0.96) < 0.02);
  assert.ok(samples.some((a) => a >= 0.99));
  assert.ok(samples.some((a) => a <= 0.93));
});
