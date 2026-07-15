import test from "node:test";
import assert from "node:assert/strict";
import { ENABLE_INFLUENCE_LAYOUT_FOR_ALL } from "../config/influenceLayout.js";
import {
  appendInfluenceLayoutSignatureSuffix,
  breathingHaloAlpha,
  breathingHaloPhaseOffsetMs,
  centerBiasMultiplier,
  collisionRadiusMultiplier,
  computeFollowerInfluenceBounds,
  createForceInfluenceCenterBias,
  deterministicUnit,
  followerInfluence,
  isInfluenceLayoutAdminPreview,
  parseDebugInfluenceLayoutParams,
  resolveUseBreathingHalo,
  resolveUseInfluenceLayout,
  selectTopBreathingHaloHandles,
  seedInfluenceLayoutPosition,
} from "./influenceLayout.js";

test("ENABLE_INFLUENCE_LAYOUT_FOR_ALL is false (admin-only preview)", () => {
  assert.equal(ENABLE_INFLUENCE_LAYOUT_FOR_ALL, false);
});

test("isInfluenceLayoutAdminPreview matches zndtoshi case-insensitively", () => {
  assert.equal(isInfluenceLayoutAdminPreview({ handle: "zndtoshi" }), true);
  assert.equal(isInfluenceLayoutAdminPreview({ handle: "@ZndToshi" }), true);
  assert.equal(isInfluenceLayoutAdminPreview({ handle: "alice" }), false);
  assert.equal(isInfluenceLayoutAdminPreview(null), false);
});

test("resolveUseInfluenceLayout: anonymous visitor gets production layout", () => {
  assert.equal(
    resolveUseInfluenceLayout({
      enabledForAll: false,
      authenticatedUser: null,
      layoutOverride: null,
    }),
    false
  );
});

test("resolveUseInfluenceLayout: other logged-in user gets production layout", () => {
  assert.equal(
    resolveUseInfluenceLayout({
      enabledForAll: false,
      authenticatedUser: { handle: "niftynei" },
      layoutOverride: null,
    }),
    false
  );
});

test("resolveUseInfluenceLayout: authenticated zndtoshi gets influence layout", () => {
  assert.equal(
    resolveUseInfluenceLayout({
      enabledForAll: false,
      authenticatedUser: { handle: "zndtoshi" },
      layoutOverride: null,
    }),
    true
  );
});

test("resolveUseInfluenceLayout: global flag true enables for everyone", () => {
  assert.equal(
    resolveUseInfluenceLayout({
      enabledForAll: true,
      authenticatedUser: null,
      layoutOverride: null,
    }),
    true
  );
  assert.equal(
    resolveUseInfluenceLayout({
      enabledForAll: true,
      authenticatedUser: { handle: "alice" },
      layoutOverride: null,
    }),
    true
  );
});

test("resolveUseInfluenceLayout: admin debug off forces production layout", () => {
  assert.equal(
    resolveUseInfluenceLayout({
      enabledForAll: false,
      authenticatedUser: { handle: "zndtoshi" },
      layoutOverride: false,
    }),
    false
  );
});

test("resolveUseInfluenceLayout: admin debug on forces experimental layout", () => {
  assert.equal(
    resolveUseInfluenceLayout({
      enabledForAll: false,
      authenticatedUser: { handle: "zndtoshi" },
      layoutOverride: true,
    }),
    true
  );
});

test("parseDebugInfluenceLayoutParams ignores spoofed query for non-admin", () => {
  const parsed = parseDebugInfluenceLayoutParams(
    "?debugInfluenceLayout=on&debugInfluenceHalo=off",
    "alice"
  );
  assert.equal(parsed.layoutOverride, null);
  assert.equal(parsed.haloOverride, null);
});

test("parseDebugInfluenceLayoutParams works only for authenticated zndtoshi", () => {
  assert.deepEqual(
    parseDebugInfluenceLayoutParams("?debugInfluenceLayout=off", "zndtoshi"),
    { layoutOverride: false, haloOverride: null }
  );
  assert.deepEqual(
    parseDebugInfluenceLayoutParams("?debugInfluenceLayout=on", "@zndtoshi"),
    { layoutOverride: true, haloOverride: null }
  );
  assert.deepEqual(
    parseDebugInfluenceLayoutParams("?debugInfluenceHalo=off", "zndtoshi"),
    { layoutOverride: null, haloOverride: false }
  );
});

test("resolveUseBreathingHalo requires influence layout unless halo debug off", () => {
  assert.equal(
    resolveUseBreathingHalo({ useInfluenceLayout: false, haloOverride: null }),
    false
  );
  assert.equal(
    resolveUseBreathingHalo({ useInfluenceLayout: true, haloOverride: null }),
    true
  );
  assert.equal(
    resolveUseBreathingHalo({ useInfluenceLayout: true, haloOverride: false }),
    false
  );
});

test("followerInfluence uses logarithmic normalization within graph bounds", () => {
  const bounds = computeFollowerInfluenceBounds([
    { followers: 1000 },
    { followers: 1_000_000 },
  ]);
  const low = followerInfluence(1000, bounds.minLog, bounds.maxLog);
  const high = followerInfluence(1_000_000, bounds.minLog, bounds.maxLog);
  assert.equal(low, 0);
  assert.equal(high, 1);
  const mid = followerInfluence(50_000, bounds.minLog, bounds.maxLog);
  assert.ok(mid > 0.2 && mid < 0.8);
});

test("larger follower count produces only modestly stronger center bias", () => {
  const small = centerBiasMultiplier(0);
  const large = centerBiasMultiplier(1);
  assert.equal(small, 0.42);
  assert.equal(large, 1);
  assert.ok(large / small < 2.5);
});

test("collision radius multiplier stays within modest spacing band", () => {
  assert.equal(collisionRadiusMultiplier(0), 1);
  assert.ok(collisionRadiusMultiplier(1) >= 1.08 && collisionRadiusMultiplier(1) <= 1.15);
});

test("deterministic seeds are stable across identical reloads", () => {
  const a = { handle: "alice", x: 0, y: 0, vx: 1, vy: 1 };
  const b = { handle: "alice", x: 0, y: 0, vx: 1, vy: 1 };
  seedInfluenceLayoutPosition(a, 400, 800);
  seedInfluenceLayoutPosition(b, 400, 800);
  assert.equal(a.x, b.x);
  assert.equal(a.y, b.y);
  assert.equal(deterministicUnit("alice", "layout-x"), deterministicUnit("alice", "layout-x"));
});

test("top-account halo selection is deterministic", () => {
  const nodes = [
    { handle: "big", followers: 900_000 },
    { handle: "mid", followers: 50_000 },
    { handle: "small", followers: 2_000 },
    { handle: "other", followers: 100_000 },
    { handle: "tiny", followers: 500 },
    { handle: "x", followers: 10_000 },
    { handle: "y", followers: 20_000 },
    { handle: "z", followers: 30_000 },
    { handle: "a", followers: 40_000 },
    { handle: "b", followers: 60_000 },
  ];
  const getStance = () => "against" as const;
  const first = selectTopBreathingHaloHandles(nodes, getStance, 6);
  const second = selectTopBreathingHaloHandles(nodes, getStance, 6);
  assert.deepEqual([...first].sort(), [...second].sort());
  assert.ok(first.has("big"));
  assert.equal(first.size, 6);
});

test("breathing halo alpha stays in subtle opacity band", () => {
  const phase = breathingHaloPhaseOffsetMs("big");
  const samples = [0, 2000, 4000, 6000, 7999].map((t) =>
    breathingHaloAlpha(t, phase, false)
  );
  for (const a of samples) {
    assert.ok(a >= 0.94 && a <= 1);
  }
});

test("reduced motion uses stable breathing halo opacity", () => {
  const a = breathingHaloAlpha(0, 0, true);
  const b = breathingHaloAlpha(5000, 0, true);
  assert.equal(a, b);
  assert.ok(a >= 0.94 && a <= 1);
});

test("influence layout signature suffix isolates cache from production", () => {
  assert.equal(appendInfluenceLayoutSignatureSuffix(false), "|0");
  assert.equal(appendInfluenceLayoutSignatureSuffix(true), "|1");
});

test("forceInfluenceCenterBias pulls high-influence nodes more strongly", () => {
  const labels = { alice: "against", bob: "against" };
  const region = { stanceCenterX: { against: 100, neutral: 200, approve: 300 }, width: 400 };
  const bounds = computeFollowerInfluenceBounds([
    { followers: 1000 },
    { followers: 1_000_000 },
  ]);
  const getInfluence = (n: { followers?: number }) =>
    followerInfluence(Number(n.followers ?? 0), bounds.minLog, bounds.maxLog);
  const force = createForceInfluenceCenterBias(
    () => region,
    () => labels,
    (n) => "against",
    getInfluence,
    400
  );
  const low = { x: 50, y: 50, vx: 0, vy: 0, followers: 1000, handle: "alice" };
  const high = { x: 50, y: 50, vx: 0, vy: 0, followers: 1_000_000, handle: "bob" };
  force.initialize([low, high]);
  force(1);
  assert.ok(Math.abs(high.vx) > Math.abs(low.vx));
  assert.ok(Math.abs(high.vy) > Math.abs(low.vy));
});

test("no strict concentric-ring ordering: high influence does not guarantee closest to center", () => {
  const nodes = [
    { handle: "whale", followers: 2_000_000, x: 0, y: 0 },
    { handle: "mid_a", followers: 80_000, x: 0, y: 0 },
    { handle: "mid_b", followers: 70_000, x: 0, y: 0 },
    { handle: "small", followers: 1_500, x: 0, y: 0 },
  ];
  const region = { stanceCenterX: { against: 100, neutral: 200, approve: 300 }, width: 400 };
  const labels = Object.fromEntries(nodes.map((n) => [n.handle, "against"]));
  const bounds = computeFollowerInfluenceBounds(nodes);
  const getInfluence = (n: { followers?: number }) =>
    followerInfluence(Number(n.followers ?? 0), bounds.minLog, bounds.maxLog);

  const simNodes = nodes.map((n) => ({
    ...n,
    vx: 0,
    vy: 0,
    x: 100 + (deterministicUnit(n.handle, "x") - 0.5) * 80,
    y: 200 + (deterministicUnit(n.handle, "y") - 0.5) * 80,
  }));

  const force = createForceInfluenceCenterBias(
    () => region,
    () => labels,
    () => "against",
    getInfluence,
    400,
    0.02
  );
  force.initialize(simNodes);
  for (let i = 0; i < 60; i++) force(0.5);

  const dist = (n: { x: number; y: number }) =>
    Math.hypot(n.x - 100, n.y - 200);
  const whale = simNodes.find((n) => n.handle === "whale")!;
  const small = simNodes.find((n) => n.handle === "small")!;
  assert.ok(dist(whale) < dist(small) + 40);
  const mids = simNodes.filter((n) => n.handle.startsWith("mid"));
  const whaleClosest = mids.every((m) => dist(whale) <= dist(m) + 5);
  assert.equal(whaleClosest, false);
});
