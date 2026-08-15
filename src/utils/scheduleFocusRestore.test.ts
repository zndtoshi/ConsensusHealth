import test from "node:test";
import assert from "node:assert/strict";
import { scheduleFocusRestore } from "./scheduleFocusRestore.js";

test("scheduleFocusRestore focuses after the scheduled frame", () => {
  let focused = 0;
  const el = { focus: () => { focused += 1; } };
  const queued: Array<() => void> = [];
  scheduleFocusRestore(el, (run) => queued.push(run));
  assert.equal(focused, 0);
  assert.equal(queued.length, 1);
  queued[0]();
  assert.equal(focused, 1);
});

test("scheduleFocusRestore no-ops for missing targets", () => {
  const queued: Array<() => void> = [];
  scheduleFocusRestore(null, (run) => queued.push(run));
  scheduleFocusRestore({}, (run) => queued.push(run));
  assert.equal(queued.length, 0);
});

test("scheduleFocusRestore swallows focus errors", () => {
  const el = {
    focus: () => {
      throw new Error("inert");
    },
  };
  const queued: Array<() => void> = [];
  scheduleFocusRestore(el, (run) => queued.push(run));
  assert.doesNotThrow(() => queued[0]());
});
