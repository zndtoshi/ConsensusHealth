import test from "node:test";
import assert from "node:assert/strict";
import { provenanceLabel } from "../api/avatarStanceHistory.js";
import {
  buildHistoryPanelView,
  historyCacheKey,
  normalizeHistoryStance,
} from "./avatarStanceHistoryPanel.js";

test("provenanceLabel maps user to Self-reported and others to Curated", () => {
  assert.equal(provenanceLabel("user"), "Self-reported");
  assert.equal(provenanceLabel("backfill"), "Curated");
  assert.equal(provenanceLabel("admin"), "Curated");
  assert.equal(provenanceLabel(null), "Curated");
});

test("buildHistoryPanelView uses curated initial when only seed event exists", () => {
  const view = buildHistoryPanelView(
    [
      {
        id: 1,
        previous_stance: null,
        new_stance: "against",
        changed_at: "2025-05-01T00:00:00.000Z",
        changed_by: "backfill",
      },
    ],
    "against"
  );
  assert.deepEqual(view, { kind: "initial", currentLabel: "Against" });
});

test("buildHistoryPanelView lists newest first for multi-event history", () => {
  const view = buildHistoryPanelView(
    [
      {
        id: 1,
        previous_stance: null,
        new_stance: "against",
        changed_at: "2025-05-01T00:00:00.000Z",
        changed_by: "backfill",
      },
      {
        id: 2,
        previous_stance: "against",
        new_stance: "neutral",
        changed_at: "2025-06-15T00:00:00.000Z",
        changed_by: "user",
      },
      {
        id: 3,
        previous_stance: "neutral",
        new_stance: "approve",
        changed_at: "2025-07-20T00:00:00.000Z",
        changed_by: "user",
      },
    ],
    "approve"
  );
  assert.equal(view.kind, "timeline");
  if (view.kind !== "timeline") return;
  assert.equal(view.rows[0]?.label, "Approve");
  assert.equal(view.rows[0]?.provenance, "Self-reported");
  assert.equal(view.rows[2]?.label, "Against");
  assert.equal(view.rows[2]?.provenance, "Curated");
});

test("historyCacheKey prefers x_user_id", () => {
  assert.equal(historyCacheKey({ xUserId: "42", handle: "a" }), "id:42");
  assert.equal(historyCacheKey({ xUserId: null, handle: "@Bob" }), "h:bob");
  assert.equal(historyCacheKey({ xUserId: null, handle: null }), null);
});

test("normalizeHistoryStance accepts support as approve", () => {
  assert.equal(normalizeHistoryStance("support"), "approve");
});
