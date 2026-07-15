import test from "node:test";
import assert from "node:assert/strict";
import {
  INTRO_FLIGHT_KEYFRAME_STEPS,
  INTRO_FLIGHT_PERF_MIN_FPS,
  IntroFlightMotionProfiler,
  flightDurationMs,
  flightStaggerMs,
  parseDebugNewStancesMotionParams,
  sampleFlightTransformAt,
} from "./newStancesFlight.js";
import {
  INTRO_FLIGHT_DURATION_MS,
  INTRO_FLIGHT_STAGGER_MS,
  INTRO_TIMING,
  buildFlightKeyframes,
} from "./newStancesIntro.js";

const sampleItem = {
  eventId: 1,
  xUserId: "u1",
  handle: "alice",
  stance: "approve" as const,
  createdAt: "2026-07-15T00:00:00.000Z",
  avatarUrl: "/a.jpg",
  finalX: 400,
  finalY: 300,
  finalSide: 20,
  stagingSx: 450,
  stagingSy: 80,
  stagingSidePx: 72,
  flightStart: 1000,
  flightEnd: 4400,
  landed: false,
  opacity: 1,
};

const sampleView = {
  cw: 900,
  ch: 600,
  headerHeight: 56,
  scale: 1,
  tx: 0,
  ty: 0,
  stanceCenterX: { against: 200, neutral: 450, approve: 700 },
};

test("parseDebugNewStancesMotionParams requires both debug flags", () => {
  assert.deepEqual(parseDebugNewStancesMotionParams("?debugNewStances=1"), { enabled: false });
  assert.deepEqual(parseDebugNewStancesMotionParams("?debugNewStancesMotion=1"), { enabled: false });
  assert.deepEqual(parseDebugNewStancesMotionParams("?debugNewStances=1&debugNewStancesMotion=1"), {
    enabled: true,
  });
});

test("flight timing helpers use shared intro constants", () => {
  assert.equal(flightDurationMs(false), INTRO_FLIGHT_DURATION_MS);
  assert.equal(flightStaggerMs(false, 2), 2 * INTRO_FLIGHT_STAGGER_MS);
  assert.equal(flightDurationMs(true), INTRO_TIMING.reducedCrossfadeMs);
  assert.equal(flightStaggerMs(true, 3), 0);
});

test("buildFlightKeyframes preserves start and end transforms", () => {
  const keyframes = buildFlightKeyframes(sampleItem, sampleView, false, INTRO_FLIGHT_KEYFRAME_STEPS);
  assert.equal(keyframes.length, INTRO_FLIGHT_KEYFRAME_STEPS + 1);
  assert.match(keyframes[0]!.transform, /translate3d\(414px, 44px, 0\) scale\(1\)/);
  const last = keyframes[keyframes.length - 1]!;
  assert.match(last.transform, /translate3d\(364px, 264px, 0\)/);
  assert.match(last.transform, /scale\(/);
  assert.equal(last.offset, 1);
});

test("sampleFlightTransformAt matches baked easing samples", () => {
  const start = sampleFlightTransformAt(sampleItem, sampleView, false, 0);
  const end = sampleFlightTransformAt(sampleItem, sampleView, false, 1);
  assert.match(start.transform, /scale\(1\)/);
  assert.ok(end.transform.includes("scale("));
  assert.notEqual(start.transform, end.transform);
});

test("IntroFlightMotionProfiler detects low FPS samples", () => {
  const profiler = new IntroFlightMotionProfiler(0);
  for (let i = 0; i < 8; i++) {
    profiler.tick(0 + i * 40);
  }
  const fps = profiler.getSampledFps(250);
  assert.ok(fps >= 20 && fps <= 30);
  assert.equal(profiler.shouldSimplifyEffects(250), fps < INTRO_FLIGHT_PERF_MIN_FPS);
});
