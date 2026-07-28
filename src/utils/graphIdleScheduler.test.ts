import test from "node:test";
import assert from "node:assert/strict";
import { createGraphIdleScheduler, IDLE_HALO_FPS } from "./graphIdleScheduler.js";

function makeFakeClock() {
  let now = 0;
  const queue = [];
  let nextId = 1;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      const due = queue.splice(0, queue.length);
      for (const job of due) job.cb(now);
    },
    raf(cb) {
      const id = nextId++;
      queue.push({ id, cb });
      return id;
    },
    caf(id) {
      const idx = queue.findIndex((j) => j.id === id);
      if (idx >= 0) queue.splice(idx, 1);
    },
    pending() {
      return queue.length;
    },
  };
}

test("IDLE_HALO_FPS is a positive throttle target", () => {
  assert.ok(IDLE_HALO_FPS >= 12 && IDLE_HALO_FPS <= 20);
});

test("single scheduler throttles idle draws and skips while interacting", () => {
  const clock = makeFakeClock();
  let draws = 0;
  let interacting = false;
  let visibility = "visible";
  const listeners = new Set();

  const scheduler = createGraphIdleScheduler({
    shouldAnimate: () => true,
    isCameraInteracting: () => interacting,
    isIntroFrozen: () => false,
    scheduleDraw: () => {
      draws += 1;
    },
    fps: 10,
    now: clock.now,
    raf: clock.raf,
    caf: clock.caf,
    getVisibilityState: () => visibility,
    addVisibilityListener: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  });

  scheduler.start();
  assert.equal(clock.pending(), 1);
  clock.advance(0); // first tick may draw immediately (lastDrawAt 0)
  assert.ok(draws >= 1);
  const afterFirst = draws;

  clock.advance(20); // < 100ms interval at 10fps — no new draw
  assert.equal(draws, afterFirst);

  clock.advance(100);
  assert.ok(draws > afterFirst);

  const beforeInteract = draws;
  interacting = true;
  clock.advance(200);
  assert.equal(draws, beforeInteract);

  interacting = false;
  clock.advance(200);
  assert.ok(draws > beforeInteract);

  scheduler.stop();
  assert.equal(clock.pending(), 0);
  assert.equal(listeners.size, 0);
});

test("scheduler pauses when document is hidden and resumes on visible", () => {
  const clock = makeFakeClock();
  let draws = 0;
  let visibility = "visible";
  let visibilityHandler = null;

  const scheduler = createGraphIdleScheduler({
    shouldAnimate: () => true,
    isCameraInteracting: () => false,
    isIntroFrozen: () => false,
    scheduleDraw: () => {
      draws += 1;
    },
    fps: 10,
    now: clock.now,
    raf: clock.raf,
    caf: clock.caf,
    getVisibilityState: () => visibility,
    addVisibilityListener: (handler) => {
      visibilityHandler = handler;
      return () => {
        visibilityHandler = null;
      };
    },
  });

  scheduler.start();
  clock.advance(0);
  const baseline = draws;

  visibility = "hidden";
  visibilityHandler();
  assert.equal(clock.pending(), 0);

  const frozen = draws;
  clock.advance(500);
  assert.equal(draws, frozen);

  visibility = "visible";
  visibilityHandler();
  assert.ok(draws > frozen);
  assert.equal(clock.pending(), 1);

  scheduler.stop();
  assert.equal(visibilityHandler, null);
});

test("scheduler does not start competing loops when start is called twice", () => {
  const clock = makeFakeClock();
  const scheduler = createGraphIdleScheduler({
    shouldAnimate: () => true,
    isCameraInteracting: () => false,
    isIntroFrozen: () => false,
    scheduleDraw: () => {},
    fps: 15,
    now: clock.now,
    raf: clock.raf,
    caf: clock.caf,
    getVisibilityState: () => "visible",
    addVisibilityListener: () => () => {},
  });
  scheduler.start();
  scheduler.start();
  assert.equal(clock.pending(), 1);
  scheduler.stop();
  assert.equal(clock.pending(), 0);
});
