import test from "node:test";
import assert from "node:assert/strict";
import type { NewStanceEvent } from "../api/newStances.js";
import { NEW_STANCES_PUBLIC_ENABLED } from "../config/newStances.js";
import {
  LAST_SEEN_MARKER_KEY,
  PLAYING_SESSION_KEY,
  computeFlightScreenPos,
  computeIntroBandLiftPx,
  computeStagingLayouts,
  computeStagingPanelBounds,
  getIntroPhase,
  headingOpacityForPhase,
  introAvatarAriaLabel,
  introAvatarEntrance,
  introCountdownDotOpacity,
  introHeadingMinContentWidthPx,
  introStanceAura,
  stagingPanelOpacityForPhase,
  INTRO_MAX_USERS,
  INTRO_FLIGHT_DURATION_MS,
  INTRO_FLIGHT_STAGGER_MS,
  INTRO_TIMING,
  INTRO_HEADING_GAP_PX,
  INTRO_HEADING_HEIGHT_PX,
  INTRO_HEADING_TOP_PX,
  isIntroNodeHidden,
  markerEventsFromIntroItems,
  matchEventsToIntroItems,
  normalizeIntroEvents,
  parseDebugNewStancesParams,
  pickNewestMarker,
  readLastSeenMarker,
  readPlayingSession,
  resolveFetchAfterEventId,
  resolveShowIntroDecision,
  shouldDeferIntroForPlayingSession,
  shouldPersistMarker,
  writeLastSeenMarker,
  writePlayingSession,
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

test("feature flag true enables intro for all visitors", () => {
  assert.equal(NEW_STANCES_PUBLIC_ENABLED, true);
  const d = resolveShowIntroDecision({ publicEnabled: true });
  assert.equal(d.show, true);
  assert.equal(d.publicEnabled, true);
});

test("feature flag false disables intro for everyone", () => {
  const d = resolveShowIntroDecision({ publicEnabled: false });
  assert.equal(d.show, false);
});

test("no admin-only restriction remains in show decision", () => {
  const d = resolveShowIntroDecision({ publicEnabled: true });
  assert.equal("adminPreview" in d, false);
  assert.equal(d.show, true);
});

test("anonymous and logged-in visitors share the same fetch rules", () => {
  const marker = { eventId: 50, createdAt: "2026-07-15T00:00:00.000Z" };
  const firstVisit = resolveFetchAfterEventId({
    publicEnabled: true,
    debug: { enabled: false, limit: 9 },
    marker: null,
  });
  const returning = resolveFetchAfterEventId({
    publicEnabled: true,
    debug: { enabled: false, limit: 9 },
    marker,
  });
  assert.equal(firstVisit, null);
  assert.equal(returning, 50);
});

test("debug query enables intro without public flag", () => {
  const debug = parseDebugNewStancesParams("?debugNewStances=1&debugNewStancesCount=3");
  const d = resolveShowIntroDecision({ publicEnabled: false, debug });
  assert.equal(d.show, true);
  assert.equal(debug.limit, 3);
});

test("debug mode ignores marker and does not update it", () => {
  const after = resolveFetchAfterEventId({
    publicEnabled: true,
    debug: { enabled: true, limit: 9 },
    marker: { eventId: 100, createdAt: "2026-07-15T00:00:00.000Z" },
  });
  assert.equal(after, null);
  assert.equal(
    shouldPersistMarker({ publicEnabled: true, debug: { enabled: true, limit: 9 } }),
    false
  );
});

test("public mode persists marker when not in debug", () => {
  assert.equal(
    shouldPersistMarker({ publicEnabled: true, debug: { enabled: false, limit: 9 } }),
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

test("maximum 9 enforced client-side", () => {
  const events = Array.from({ length: 12 }, (_, i) =>
    sampleEvent(i + 1, `u${i}`, "neutral")
  );
  const out = normalizeIntroEvents(events, 9);
  assert.equal(out.length, 9);
  assert.equal(out[0]!.eventId, 12);
  assert.equal(out[8]!.eventId, 4);
});

test("marker advances to newest displayed event only", () => {
  const displayed = markerEventsFromIntroItems([
    { eventId: 3, createdAt: sampleEvent(3, "a", "against").createdAt },
    { eventId: 9, createdAt: sampleEvent(9, "b", "approve").createdAt },
  ]);
  const marker = pickNewestMarker(displayed);
  assert.deepEqual(marker, { eventId: 9, createdAt: sampleEvent(9, "b", "approve").createdAt });
});

test("skipped unseen events beyond the 9-cap are not in the marker batch", () => {
  const fetched = Array.from({ length: 12 }, (_, i) =>
    sampleEvent(i + 1, `u${i}`, "neutral")
  );
  const displayed = normalizeIntroEvents(fetched, 9);
  const marker = pickNewestMarker(displayed);
  assert.equal(marker?.eventId, 12);
  assert.equal(displayed.length, 9);
  assert.equal(displayed.some((e) => e.eventId === 1), false);
});

test("localStorage marker roundtrip", () => {
  const s = memStorage();
  writeLastSeenMarker(s, { eventId: 77, createdAt: "2026-07-15T12:00:00.000Z" });
  assert.deepEqual(readLastSeenMarker(s), { eventId: 77, createdAt: "2026-07-15T12:00:00.000Z" });
  const raw = s.getItem(LAST_SEEN_MARKER_KEY);
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw!), { eventId: 77, createdAt: "2026-07-15T12:00:00.000Z" });
});

test("refresh mid-animation defers replay while session is fresh", () => {
  const session = memStorage();
  writePlayingSession(session, {
    batchId: "batch-1",
    eventIds: [10, 11],
    startedAt: new Date().toISOString(),
  });
  const playing = readPlayingSession(session);
  assert.ok(playing);
  assert.equal(
    shouldDeferIntroForPlayingSession(playing, {
      publicEnabled: true,
      debug: { enabled: false, limit: 9 },
    }),
    true
  );
});

test("stale in-progress session does not block a new intro", () => {
  const session = memStorage();
  writePlayingSession(session, {
    batchId: "batch-1",
    eventIds: [10],
    startedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  assert.equal(readPlayingSession(session), null);
  assert.equal(
    shouldDeferIntroForPlayingSession(null, {
      publicEnabled: true,
      debug: { enabled: false, limit: 9 },
    }),
    false
  );
});

test("debug mode does not defer for in-progress session", () => {
  const playing = {
    batchId: "batch-1",
    eventIds: [10],
    startedAt: new Date().toISOString(),
  };
  assert.equal(
    shouldDeferIntroForPlayingSession(playing, {
      publicEnabled: true,
      debug: { enabled: true, limit: 9 },
    }),
    false
  );
});

test("no-new-events means intro should not start", () => {
  assert.equal(normalizeIntroEvents([], 9).length, 0);
});

test("reduced motion uses the same staging hold before flight", () => {
  assert.equal(getIntroPhase(1500, true), "hold");
  assert.equal(getIntroPhase(INTRO_TIMING.holdMs - 1, true), "hold");
  assert.equal(getIntroPhase(INTRO_TIMING.holdMs, true), "flying");
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

test("intro avatar entrance scales and fades with stagger", () => {
  const first = introAvatarEntrance(0, 150, false);
  const second = introAvatarEntrance(1, 150, false);
  assert.ok(first.opacity > second.opacity);
  assert.ok(first.scale > 0.92 && first.scale <= 1);
  const reduced = introAvatarEntrance(0, 150, true);
  assert.equal(reduced.scale, 1);
});

test("intro stance aura uses graph stance colors", () => {
  assert.equal(introStanceAura("against").border, "#ef4444");
  assert.equal(introStanceAura("approve").border, "#22c55e");
  assert.equal(introStanceAura("neutral").border, "#9ca3af");
});

test("intro aria labels preserve accessible names without visible handles", () => {
  assert.match(introAvatarAriaLabel("alice", "approve"), /@alice, stance Approve/);
});

test("arrival flight timing is tunable from shared constants", () => {
  assert.equal(INTRO_FLIGHT_DURATION_MS, 3400);
  assert.equal(INTRO_FLIGHT_STAGGER_MS, 120);
  assert.equal(INTRO_TIMING.flightMs, INTRO_FLIGHT_DURATION_MS);
  assert.equal(INTRO_TIMING.flightStaggerMs, INTRO_FLIGHT_STAGGER_MS);
  assert.equal(INTRO_TIMING.holdMs, 3000);
});

test("countdown dots appear only near end of hold", () => {
  assert.equal(introCountdownDotOpacity(0, "hold", 1000, false), 0);
  assert.ok(introCountdownDotOpacity(0, "hold", 2500, false) > 0.1);
  assert.equal(introCountdownDotOpacity(0, "flying", 3100, false), 0);
});

test("panel fades quickly when flight begins", () => {
  const atFlight = stagingPanelOpacityForPhase(
    "flying",
    INTRO_TIMING.holdMs + INTRO_TIMING.panelFlightFadeMs,
    9,
    false
  );
  assert.ok(atFlight < 0.2);
});

test("intro band lift reaches the header vertical midpoint", () => {
  assert.equal(computeIntroBandLiftPx(56), 28);
  assert.equal(computeIntroBandLiftPx(0), 0);
});

test("staging layouts use a tight centered row under the heading", () => {
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
  assert.ok(b.sx - a.sx < 70);
  assert.ok(Math.abs((a.sx + c.sx) / 2 - view.cw / 2) < 2);
  const avatarTopY = a.sy - a.stagingSidePx / 2;
  assert.ok(avatarTopY >= INTRO_HEADING_TOP_PX + INTRO_HEADING_HEIGHT_PX + INTRO_HEADING_GAP_PX - 0.5);
});

test("staging panel stays visible through full 3s hold then fades on flight", () => {
  const holdAt2500 = stagingPanelOpacityForPhase("hold", 2500, 9, false);
  const holdAt2999 = stagingPanelOpacityForPhase("hold", 2999, 9, false);
  const flightStart = stagingPanelOpacityForPhase("flying", INTRO_TIMING.holdMs, 9, false);
  const flightMid = stagingPanelOpacityForPhase("flying", INTRO_TIMING.holdMs + 600, 9, false);
  assert.ok(holdAt2500 > 0.9);
  assert.ok(holdAt2999 > 0.9);
  assert.ok(flightStart > 0.85);
  assert.ok(flightMid < flightStart);
  assert.equal(headingOpacityForPhase("hold", 2500, false, 9), 1);
});

test("computeStagingPanelBounds wraps heading and avatar row", () => {
  const view = {
    cw: 900,
    ch: 600,
    headerHeight: 56,
    scale: 1,
    tx: 0,
    ty: 0,
    stanceCenterX: { against: 200, neutral: 450, approve: 700 },
  };
  const panel = computeStagingPanelBounds(9, 48, view);
  assert.ok(panel.w > 200);
  assert.ok(panel.h > 70);
  assert.ok(panel.x > 0);
  assert.ok(panel.x + panel.w < view.cw);
});

test("single-avatar panel is wide enough for the heading text", () => {
  const view = {
    cw: 900,
    ch: 600,
    headerHeight: 56,
    scale: 1,
    tx: 0,
    ty: 0,
    stanceCenterX: { against: 200, neutral: 450, approve: 700 },
  };
  const stagingSidePx = 60;
  const panel = computeStagingPanelBounds(1, stagingSidePx, view);
  const minInner = introHeadingMinContentWidthPx();
  assert.ok(panel.w >= minInner + 32);
  assert.ok(Math.abs(panel.x + panel.w / 2 - view.cw / 2) < 1);
  assert.ok(stagingSidePx + 32 < panel.w);
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
  assert.equal(hold.labelOpacity, 0);
  const mid = computeFlightScreenPos(item, 1500, view, false);
  assert.ok(mid.sidePx < 72 && mid.sidePx > 20);
  assert.equal(mid.labelOpacity, 0);
  const done = computeFlightScreenPos(item, 2500, view, false);
  assert.equal(done.sidePx, 20);
  assert.equal(done.labelOpacity, 0);
});

test("storage keys are versioned v2", () => {
  assert.equal(LAST_SEEN_MARKER_KEY, "consensus_health_last_seen_stance_event_v2");
  assert.equal(PLAYING_SESSION_KEY, "consensus_health_new_stances_playing_v2");
  assert.equal(INTRO_MAX_USERS, 9);
});
