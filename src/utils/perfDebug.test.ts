import test from "node:test";
import assert from "node:assert/strict";
import {
  initPerfDebug,
  isPerfDebugEnabled,
  parseDebugPerformance,
  perfCounters,
  perfInc,
  perfRecordDragFrame,
  perfDragFps,
} from "./perfDebug.js";

test("parseDebugPerformance recognizes 1/true", () => {
  assert.equal(parseDebugPerformance("?debugPerformance=1"), true);
  assert.equal(parseDebugPerformance("?debugPerformance=true"), true);
  assert.equal(parseDebugPerformance(""), false);
  assert.equal(parseDebugPerformance("?foo=1"), false);
});

test("perf counters stay silent until enabled", () => {
  initPerfDebug("");
  assert.equal(isPerfDebugEnabled(), false);
  perfInc("drawCalls", 5);
  assert.equal(perfCounters().drawCalls, 0);
});

test("enabled debug records drag frame stats", () => {
  assert.equal(initPerfDebug("?debugPerformance=1"), true);
  assert.equal(isPerfDebugEnabled(), true);
  perfRecordDragFrame(10);
  perfRecordDragFrame(20);
  assert.equal(perfCounters().dragFrames, 2);
  assert.equal(perfCounters().dragFrameMsMax, 20);
  assert.equal(perfDragFps(), 67);
});
