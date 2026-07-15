import test from "node:test";
import assert from "node:assert/strict";
import {
  clampNewStancesLimit,
  mapNewStanceEventRow,
  NEW_STANCES_MAX_LIMIT,
} from "./newStances.js";

test("clampNewStancesLimit caps at 9", () => {
  assert.equal(clampNewStancesLimit(99), NEW_STANCES_MAX_LIMIT);
  assert.equal(clampNewStancesLimit(3), 3);
  assert.equal(clampNewStancesLimit("bad"), NEW_STANCES_MAX_LIMIT);
});

test("mapNewStanceEventRow maps public fields", () => {
  const row = mapNewStanceEventRow({
    id: 42,
    x_user_id: "xid-1",
    handle: "@Alice",
    name: "Alice",
    new_stance: "approve",
    changed_at: "2026-07-15T10:00:00.000Z",
    avatar_path: "/avatars/xid-1.jpg",
  });
  assert.ok(row);
  assert.equal(row!.eventId, 42);
  assert.equal(row!.xUserId, "xid-1");
  assert.equal(row!.handle, "alice");
  assert.equal(row!.stance, "approve");
  assert.equal(row!.avatarPath, "/avatars/xid-1.jpg");
  assert.equal(row!.hasAvatarBlob, true);
});

test("mapNewStanceEventRow rejects invalid rows", () => {
  assert.equal(mapNewStanceEventRow({ id: 0, x_user_id: "x", new_stance: "approve" }), null);
  assert.equal(mapNewStanceEventRow({ id: 1, x_user_id: "", new_stance: "approve" }), null);
});
