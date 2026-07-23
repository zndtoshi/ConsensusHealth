import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeHistoryStagingSlots,
  fillHistorySlots,
  HISTORY_HOLD_MS,
  HISTORY_LAUNCH_STAGGER_MS,
  HISTORY_STAGE_COUNT,
  historyPlaybackComplete,
  launchNextStagedAvatar,
} from "./adminHistoryPlayback.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");

test("history staging uses 7 slots and 3s hold with 200ms launch stagger", () => {
  assert.equal(HISTORY_STAGE_COUNT, 7);
  assert.equal(HISTORY_HOLD_MS, 3000);
  assert.equal(HISTORY_LAUNCH_STAGGER_MS, 200);
  const slots = computeHistoryStagingSlots(7, 1000, 800, 56);
  assert.equal(slots.length, 7);
  assert.ok(slots[0]!.cx < slots[6]!.cx);
});

test("fillHistorySlots fills empties from chronological queue", () => {
  const sequence = Array.from({ length: 10 }, (_, i) => ({ handle: `u${i}` }));
  const slots = Array.from({ length: 7 }, () => null);
  const next = fillHistorySlots({ slots, sequence, queueIndex: 0 });
  assert.equal(next, 7);
  assert.equal(slots[0]?.handle, "u0");
  assert.equal(slots[6]?.handle, "u6");
});

test("launchNextStagedAvatar launches lowest seqIndex and refills vacated slot", () => {
  const sequence = Array.from({ length: 10 }, (_, i) => ({ handle: `u${i}` }));
  const slots = Array.from({ length: 7 }, () => null);
  let qi = fillHistorySlots({ slots, sequence, queueIndex: 0 });
  const { queueIndex, launched } = launchNextStagedAvatar({
    slots,
    sequence,
    queueIndex: qi,
    now: 1000,
    flightMs: 1400,
  });
  assert.ok(launched);
  assert.equal(launched.handle, "u0");
  assert.equal(launched.slotIndex, 0);
  assert.equal(launched.endMs - launched.startMs, 1400);
  // Vacated slot immediately refilled with next in queue.
  assert.equal(slots[0]?.handle, "u7");
  assert.equal(queueIndex, 8);
});

test("historyPlaybackComplete waits until all landed and queues empty", () => {
  assert.equal(
    historyPlaybackComplete({
      sequenceLength: 3,
      landedCount: 3,
      flyingCount: 0,
      stagedCount: 0,
      queueIndex: 3,
    }),
    true
  );
  assert.equal(
    historyPlaybackComplete({
      sequenceLength: 3,
      landedCount: 2,
      flyingCount: 1,
      stagedCount: 0,
      queueIndex: 3,
    }),
    false
  );
});

test("App gates History transport to authenticated zndtoshi admin", () => {
  assert.match(appSrc, /canUseAdminHistory/);
  assert.match(appSrc, /AdminHistoryTransport|historyTransportOpen/);
  assert.match(appSrc, /isPrivilegedManualEditor\(me\?\.handle\)/);
  assert.match(appSrc, /me\?\.authenticated === true/);
  // Public Play History label should not remain as the primary control.
  assert.doesNotMatch(appSrc, />Play History</);
});
