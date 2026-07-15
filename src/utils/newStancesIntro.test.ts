import test from "node:test";
import assert from "node:assert/strict";
import type { NewStanceEvent } from "../api/newStances.js";
import { NEW_STANCES_PUBLIC_ENABLED } from "../config/newStances.js";
import {
  LAST_SEEN_MARKER_KEY,
  computeFlightScreenPos,
  computeStagingLayouts,
  computeStagingSidePx,
  isIntroNodeHidden,
  matchEventsToIntroItems,
  normalizeIntroEvents,
  parseDebugNewStancesParams,
  pickNewestMarker,
  readLastSeenMarker,
  resolveFetchAfterEventId,
  resolveShowIntroDecision,
  shouldPersistMarker,
  writeLastSeenMarker,
} from "./newStancesIntro.js";

const memStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
};

function sampleEvent(id: number, xUserId: string, stance: "against" | "neutral" | "approve"): NewStanceEvent {
  return {
    eventId: id,
    xUserId,
    handle: `user${id}`,
    displayName: null,
    stance,
    createdAt: new Date(Date.UTC(2026, 6, 15, 12, id)).toISOString(),
    avatarPath: null,
    hasAvatarBlob: false,
  };
}

test("public flag false blocks non-admin preview", () => {
  const d = resolveShowIntroDecision({ adminPreviewFromServer: false, publicEnabled: false });
  assert.equal(d.show, false);
  assert.equal(NEW_STANCES_PUBLIC_ENABLED, false);
});

test("admin preview from server enables intro", () => {
  const d = resolveShowIntroDecision({ adminPreviewFromServer: true });
  assert.equal(d.show, true);
  assert.equal(d.adminPreview, true);
});

test("debug query enables intro without public flag", () => {
  const debug = parseDebugNewStancesParams("?debugNewStances=1&debugNewStancesCount=3");
  const d = resolveShowIntroDecision({ adminPreviewFromServer: false, debug });
  assert.equal(d.show, true);
  assert.equal(debug.limit, 3);
});

test("first visit marker null fetches without afterEventId when public", () => {
  const after = resolveFetchAfterEventId({
    adminPreview: false,
    publicEnabled: true,
    debug: { enabled: false, limit: 9 },
    marker: null,
  });
  assert.equal(after, null);
});

test("repeat visit uses marker when public", () => {
  const after = resolveFetchAfterEventId({
    adminPreview: false,
    publicEnabled: true,
    debug: { enabled: false, limit: 9 },
    marker: { eventId: 100, createdAt: "2026-07-15T00:00:00.000Z" },
  });
  assert.equal(after, 100);
});

test("admin preview ignores marker fetch filter", () => {
  const after = resolveFetchAfterEventId({
    adminPreview: true,
    publicEnabled: false,
    debug: { enabled: false, limit: 9 },
    marker: { eventId: 100, createdAt: "2026-07-15T00:00:00.000Z" },
  });
  assert.equal(after, null);
});

test("zndtoshi preview does not persist marker", () => {
  assert.equal(
    shouldPersistMarker({ adminPreview: true, publicEnabled: false, debug: { enabled: false, limit: 9 } }),
    false
  );
});

test("public mode persists marker when not debug/admin", () => {
  assert.equal(
    shouldPersistMarker({ adminPreview: false, publicEnabled: true, debug: { enabled: false, limit: 9 } }),
    true
  );
});

test("corrupt localStorage marker returns null", () => {
  const s = memStorage();
  s.setItem(LAST_SEEN_MARKER_KEY, "{not-json");
  assert.equal(readLastSeenMarker(s), null);
});

test("normalizeIntroEvents dedupes to latest per user and caps at 9", () => {
  const events = [
    sampleEvent(1, "a", "against"),
    sampleEvent(5, "a", "approve"),
    sampleEvent(2, "b", "neutral"),
  ];
  const out = normalizeIntroEvents(events, 9);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.xUserId === "a")?.eventId, 5);
});

test("matchEventsToIntroItems reserves final graph coordinates", () => {
  const events = [sampleEvent(10, "u1", "against")];
  const nodes = [
    { x_user_id: "u1", handle: "user10", x: 120, y: 340, side: 24, avatarUrl: "/avatars/u1.jpg" },
  ];
  const items = matchEventsToIntroItems(events, nodes, (e, nodeUrl) => nodeUrl || "/missing.svg");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.finalX, 120);
  assert.equal(items[0]!.finalY, 340);
});

test("intro nodes hidden until landed", () => {
  const hidden = new Set(["u1"]);
  const landed = new Set<string>();
  assert.equal(isIntroNodeHidden("u1", hidden, landed), true);
  landed.add("u1");
  assert.equal(isIntroNodeHidden("u1", hidden, landed), false);
});

test("pickNewestMarker chooses highest event id", () => {
  const marker = pickNewestMarker([sampleEvent(3, "a", "against"), sampleEvent(9, "b", "approve")]);
  assert.deepEqual(marker, { eventId: 9, createdAt: sampleEvent(9, "b", "approve").createdAt });
});

test("write and read marker roundtrip", () => {
  const s = memStorage();
  writeLastSeenMarker(s, { eventId: 77, createdAt: "2026-07-15T12:00:00.000Z" });
  assert.deepEqual(readLastSeenMarker(s), { eventId: 77, createdAt: "2026-07-15T12:00:00.000Z" });
});

test("staging layouts use equal size in a centered top row with wide slots", () => {
  const view = {
    cw: 900,
    ch: 600,
    headerHeight: 56,
    scale: 1,
    tx: 0,
    ty: 0,
    stanceCenterX: { against: 200, neutral: 450, approve: 700 },
  };
  const layouts = computeStagingLayouts(
    [
      { xUserId: "a", handle: "short" },
      { xUserId: "b", handle: "mediumname" },
      { xUserId: "c", handle: "verylonghandle" },
    ],
    view
  );
  const a = layouts.get("a")!;
  const b = layouts.get("b")!;
  const c = layouts.get("c")!;
  assert.equal(a.stagingSidePx, b.stagingSidePx);
  assert.equal(b.stagingSidePx, c.stagingSidePx);
  assert.ok(b.sx - a.sx >= 70);
  assert.ok(c.sx - b.sx >= 70);
  assert.ok(Math.abs((a.sx + c.sx) / 2 - view.cw / 2) < 4);
});

test("flight interpolates avatar size and fades handle label", () => {
  const item = {
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
    flightEnd: 2000,
    landed: false,
    opacity: 1,
  };
  const view = {
    cw: 900,
    ch: 600,
    headerHeight: 56,
    scale: 1,
    tx: 0,
    ty: 0,
    stanceCenterX: { against: 200, neutral: 450, approve: 700 },
  };
  const hold = computeFlightScreenPos(item, 500, view, false);
  assert.equal(hold.sidePx, 72);
  assert.equal(hold.labelOpacity, 1);
  const mid = computeFlightScreenPos(item, 1500, view, false);
  assert.ok(mid.sidePx < 72 && mid.sidePx > 20);
  assert.ok(mid.labelOpacity < 1 && mid.labelOpacity > 0);
  const done = computeFlightScreenPos(item, 2500, view, false);
  assert.equal(done.sidePx, 20);
  assert.equal(done.labelOpacity, 0);
});
