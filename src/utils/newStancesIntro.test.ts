import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEW_STANCES_MARKER_KEY,
  NEW_STANCES_MAX,
  computeNewestMarker,
  filterNewerThanMarker,
  prefersReducedMotion,
  readLastSeenMarker,
  selectIntroEvents,
  writeLastSeenMarker,
  type IntroStorage,
  type NewStanceEvent,
} from "./newStancesIntro.js";

function fakeStorage(initial?: Record<string, string>): IntroStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

function ev(partial: Partial<NewStanceEvent> & { eventId: number; xUserId: string }): NewStanceEvent {
  return {
    handle: `h${partial.xUserId}`,
    displayName: `Name ${partial.xUserId}`,
    stance: "approve",
    createdAt: "2026-07-14T12:00:00.000Z",
    ...partial,
  };
}

test("readLastSeenMarker returns null for a first visit (no saved marker)", () => {
  assert.equal(readLastSeenMarker(fakeStorage()), null);
  assert.equal(readLastSeenMarker(null), null);
});

test("readLastSeenMarker returns a valid saved marker", () => {
  const storage = fakeStorage({
    [NEW_STANCES_MARKER_KEY]: JSON.stringify({ eventId: 42, createdAt: "2026-07-14T00:00:00.000Z" }),
  });
  assert.deepEqual(readLastSeenMarker(storage), { eventId: 42, createdAt: "2026-07-14T00:00:00.000Z" });
});

test("readLastSeenMarker tolerates corrupted / invalid JSON", () => {
  assert.equal(readLastSeenMarker(fakeStorage({ [NEW_STANCES_MARKER_KEY]: "{not json" })), null);
  assert.equal(readLastSeenMarker(fakeStorage({ [NEW_STANCES_MARKER_KEY]: "null" })), null);
  assert.equal(readLastSeenMarker(fakeStorage({ [NEW_STANCES_MARKER_KEY]: JSON.stringify({ eventId: "x" }) })), null);
  assert.equal(readLastSeenMarker(fakeStorage({ [NEW_STANCES_MARKER_KEY]: JSON.stringify({ eventId: -1 }) })), null);
});

test("writeLastSeenMarker persists an idempotent, valid marker", () => {
  const storage = fakeStorage();
  assert.equal(writeLastSeenMarker(storage, { eventId: 7, createdAt: "2026-07-14T00:00:00.000Z" }), true);
  assert.deepEqual(readLastSeenMarker(storage), { eventId: 7, createdAt: "2026-07-14T00:00:00.000Z" });
  assert.equal(writeLastSeenMarker(storage, { eventId: 0, createdAt: "" }), false);
});

test("filterNewerThanMarker keeps only events newer than the marker", () => {
  const events = [ev({ eventId: 10, xUserId: "a" }), ev({ eventId: 20, xUserId: "b" }), ev({ eventId: 30, xUserId: "c" })];
  const out = filterNewerThanMarker(events, { eventId: 20, createdAt: "" });
  assert.deepEqual(out.map((e) => e.eventId), [30]);
  assert.deepEqual(filterNewerThanMarker(events, null).map((e) => e.eventId), [10, 20, 30]);
});

test("selectIntroEvents returns only the latest event per user", () => {
  const events = [
    ev({ eventId: 5, xUserId: "a", stance: "against" }),
    ev({ eventId: 9, xUserId: "a", stance: "approve" }),
    ev({ eventId: 7, xUserId: "b", stance: "neutral" }),
  ];
  const out = selectIntroEvents(events);
  assert.equal(out.length, 2);
  const a = out.find((e) => e.xUserId === "a")!;
  assert.equal(a.eventId, 9);
  assert.equal(a.stance, "approve");
});

test("selectIntroEvents sorts newest-first and caps at the max (9)", () => {
  const events = Array.from({ length: 15 }, (_, i) => ev({ eventId: i + 1, xUserId: `u${i + 1}` }));
  const out = selectIntroEvents(events);
  assert.equal(out.length, NEW_STANCES_MAX);
  assert.equal(out[0].eventId, 15);
  assert.equal(out[out.length - 1].eventId, 7);
});

test("selectIntroEvents honors a smaller max (first-visit default of e.g. 9, custom 6)", () => {
  const events = Array.from({ length: 12 }, (_, i) => ev({ eventId: i + 1, xUserId: `u${i + 1}` }));
  assert.equal(selectIntroEvents(events, { max: 6 }).length, 6);
});

test("selectIntroEvents drops events with missing handle, xUserId, or invalid stance", () => {
  const events = [
    ev({ eventId: 1, xUserId: "a", handle: null }),
    ev({ eventId: 2, xUserId: "", handle: "x" }),
    ev({ eventId: 3, xUserId: "c", stance: "unset" }),
    ev({ eventId: 4, xUserId: "d", stance: "approve" }),
  ];
  const out = selectIntroEvents(events);
  assert.deepEqual(out.map((e) => e.xUserId), ["d"]);
});

test("computeNewestMarker returns the highest eventId marker", () => {
  const events = [ev({ eventId: 3, xUserId: "a" }), ev({ eventId: 99, xUserId: "b", createdAt: "2026-01-01T00:00:00.000Z" })];
  assert.deepEqual(computeNewestMarker(events), { eventId: 99, createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(computeNewestMarker([]), null);
});

test("prefersReducedMotion reads matchMedia and defaults false when unavailable", () => {
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({}), false);
});
