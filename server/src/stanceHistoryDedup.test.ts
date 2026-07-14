import test from "node:test";
import assert from "node:assert/strict";
import { decodeStanceHistoryCursor } from "./stanceHistory.js";
import {
  selectLatestStanceEventsPerUser,
  type DedupableStanceEvent,
} from "./stanceHistoryDedup.js";

type Evt = DedupableStanceEvent & { new_stance: string };

test("a user with several events appears only once, using the newest event", () => {
  const events: Evt[] = [
    { id: 1, x_user_id: "alice", changed_at: "2026-07-13T12:05:00.000Z", new_stance: "against" },
    { id: 2, x_user_id: "alice", changed_at: "2026-07-13T12:10:00.000Z", new_stance: "neutral" },
    { id: 3, x_user_id: "alice", changed_at: "2026-07-13T12:15:00.000Z", new_stance: "approve" },
  ];
  const { items } = selectLatestStanceEventsPerUser(events, { limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 3);
  assert.equal(items[0].new_stance, "approve");
});

test("equal timestamps use the unique event id as the deterministic tie-breaker", () => {
  const ts = "2026-07-13T12:00:00.000Z";
  const events: Evt[] = [
    { id: 10, x_user_id: "bob", changed_at: ts, new_stance: "neutral" },
    { id: 42, x_user_id: "bob", changed_at: ts, new_stance: "against" },
    { id: 7, x_user_id: "bob", changed_at: ts, new_stance: "approve" },
  ];
  const { items } = selectLatestStanceEventsPerUser(events, { limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 42);
  assert.equal(items[0].new_stance, "against");
});

test("two users with the same handle remain separate if their internal ids differ", () => {
  // Same display handle upstream, but distinct stable x_user_id values.
  const events: (Evt & { handle: string })[] = [
    { id: 1, x_user_id: "user-A", changed_at: "2026-07-13T10:00:00.000Z", new_stance: "against", handle: "o0oo0o0ooo00" },
    { id: 2, x_user_id: "user-B", changed_at: "2026-07-13T11:00:00.000Z", new_stance: "approve", handle: "o0oo0o0ooo00" },
  ];
  const { items } = selectLatestStanceEventsPerUser(events, { limit: 10 });
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i) => i.x_user_id),
    ["user-B", "user-A"]
  );
});

test("list is ordered newest-to-oldest by each user's latest event", () => {
  const events: Evt[] = [
    { id: 1, x_user_id: "a", changed_at: "2026-07-13T09:00:00.000Z", new_stance: "against" },
    { id: 2, x_user_id: "b", changed_at: "2026-07-13T12:00:00.000Z", new_stance: "neutral" },
    { id: 3, x_user_id: "c", changed_at: "2026-07-13T11:00:00.000Z", new_stance: "approve" },
  ];
  const { items } = selectLatestStanceEventsPerUser(events, { limit: 10 });
  assert.deepEqual(
    items.map((i) => i.x_user_id),
    ["b", "c", "a"]
  );
});

function makeUsers(count: number): Evt[] {
  const events: Evt[] = [];
  for (let u = 0; u < count; u++) {
    // Two events per user; the later one (higher minute + id) must win.
    const uid = `u${String(u).padStart(3, "0")}`;
    events.push({
      id: u * 2 + 1,
      x_user_id: uid,
      changed_at: `2026-07-13T10:${String(u).padStart(2, "0")}:00.000Z`,
      new_stance: "neutral",
    });
    events.push({
      id: u * 2 + 2,
      x_user_id: uid,
      changed_at: `2026-07-13T11:${String(u).padStart(2, "0")}:00.000Z`,
      new_stance: "approve",
    });
  }
  return events;
}

test("initial page returns 10 unique users and load more returns the next unique users without duplicates", () => {
  const events = makeUsers(25);

  const page1 = selectLatestStanceEventsPerUser(events, { limit: 10 });
  assert.equal(page1.items.length, 10);
  assert.equal(new Set(page1.items.map((i) => i.x_user_id)).size, 10);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);
  // Every returned event is the user's latest (approve), never the intermediate neutral.
  assert.ok(page1.items.every((i) => i.new_stance === "approve"));

  const cursor1 = decodeStanceHistoryCursor(page1.next_cursor);
  const page2 = selectLatestStanceEventsPerUser(events, { limit: 10, cursor: cursor1 });
  assert.equal(page2.items.length, 10);
  assert.equal(page2.has_more, true);

  const cursor2 = decodeStanceHistoryCursor(page2.next_cursor);
  const page3 = selectLatestStanceEventsPerUser(events, { limit: 10, cursor: cursor2 });
  assert.equal(page3.items.length, 5);
  assert.equal(page3.has_more, false);
  assert.equal(page3.next_cursor, null);

  const seen = [...page1.items, ...page2.items, ...page3.items].map((i) => i.x_user_id);
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, "no duplicate users across pages");
});
