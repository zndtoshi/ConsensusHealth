import test from "node:test";
import assert from "node:assert/strict";
import {
  createHistoryEvent,
  normalizeStanceValue,
  shouldBackfillInitialHistory,
  isPrivilegedManualEditorHandle,
  shouldRecordStanceChange,
  sortHistoryByChangedAtAsc,
  summarizeHistory,
  type HistoryEvent,
} from "./stanceHistory.js";

test("normalizeStanceValue maps support to approve", () => {
  assert.equal(normalizeStanceValue("support"), "approve");
  assert.equal(normalizeStanceValue("approve"), "approve");
  assert.equal(normalizeStanceValue("against"), "against");
  assert.equal(normalizeStanceValue("neutral"), "neutral");
  assert.equal(normalizeStanceValue("weird"), null);
});

test("creating first stance event from unset records exactly one event", () => {
  const evt = createHistoryEvent({
    x_user_id: "123",
    previous_stance: null,
    new_stance: "against",
    changed_by: "user",
    changed_at: "2026-03-01T00:00:00.000Z",
  });
  assert.ok(evt);
  assert.equal(evt?.previous_stance, null);
  assert.equal(evt?.new_stance, "against");
});

test("same stance twice does not create duplicate event", () => {
  assert.equal(shouldRecordStanceChange("neutral", "neutral"), false);
  const evt = createHistoryEvent({
    x_user_id: "123",
    previous_stance: "neutral",
    new_stance: "neutral",
    changed_by: "user",
  });
  assert.equal(evt, null);
});

test("changing stance records exactly one event", () => {
  assert.equal(shouldRecordStanceChange("against", "approve"), true);
  const evt = createHistoryEvent({
    x_user_id: "123",
    previous_stance: "against",
    new_stance: "approve",
    changed_by: "admin",
  });
  assert.ok(evt);
  assert.equal(evt?.previous_stance, "against");
  assert.equal(evt?.new_stance, "approve");
});

test("backfill only inserts initial rows for users with no history", () => {
  assert.equal(shouldBackfillInitialHistory({ hasHistory: false, currentStance: "against" }), true);
  assert.equal(shouldBackfillInitialHistory({ hasHistory: true, currentStance: "against" }), false);
  assert.equal(shouldBackfillInitialHistory({ hasHistory: false, currentStance: null }), false);
});

test("history ordering is ascending by changed_at", () => {
  const rows: HistoryEvent[] = [
    {
      x_user_id: "1",
      previous_stance: "neutral",
      new_stance: "approve",
      changed_at: "2026-03-03T10:00:00.000Z",
      changed_by: "user",
    },
    {
      x_user_id: "1",
      previous_stance: null,
      new_stance: "neutral",
      changed_at: "2026-03-01T10:00:00.000Z",
      changed_by: "backfill",
    },
  ];
  const sorted = sortHistoryByChangedAtAsc(rows);
  assert.equal(sorted[0]?.changed_at, "2026-03-01T10:00:00.000Z");
  assert.equal(sorted[1]?.changed_at, "2026-03-03T10:00:00.000Z");
});

test("history summary computes totals and transitions", () => {
  const rows: HistoryEvent[] = [
    {
      x_user_id: "1",
      previous_stance: null,
      new_stance: "neutral",
      changed_at: "2026-03-01T10:00:00.000Z",
      changed_by: "backfill",
    },
    {
      x_user_id: "1",
      previous_stance: "neutral",
      new_stance: "approve",
      changed_at: "2026-03-03T10:00:00.000Z",
      changed_by: "user",
    },
    {
      x_user_id: "2",
      previous_stance: "against",
      new_stance: "neutral",
      changed_at: "2026-03-04T10:00:00.000Z",
      changed_by: "user",
    },
  ];
  const summary = summarizeHistory(rows);
  assert.equal(summary.totalChanges, 3);
  assert.equal(summary.changedUsers, 2);
  assert.equal(summary.transitionCounts["unset->neutral"], 1);
  assert.equal(summary.transitionCounts["neutral->approve"], 1);
  assert.equal(summary.transitionCounts["against->neutral"], 1);
});

test("manual admin privilege check is disabled for all users", () => {
  assert.equal(isPrivilegedManualEditorHandle("zndtoshi"), false);
  assert.equal(isPrivilegedManualEditorHandle("@zndtoshi"), false);
  assert.equal(isPrivilegedManualEditorHandle("ZndToshi "), false);
  assert.equal(isPrivilegedManualEditorHandle("other"), false);
});

test("admin history event keeps changed_by admin", () => {
  const evt = createHistoryEvent({
    x_user_id: "99",
    previous_stance: "neutral",
    new_stance: "against",
    changed_by: "admin",
    changed_at: "2026-03-03T00:00:00.000Z",
  });
  assert.equal(evt?.changed_by, "admin");
});
