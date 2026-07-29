import test from "node:test";
import assert from "node:assert/strict";
import {
  filterOutRemovedCommunityUsers,
  isRemovedCommunityUser,
  normalizeRemovedHandle,
  resolveRemovalTarget,
} from "./removedCommunityUsers.js";

test("normalizeRemovedHandle strips @ and case", () => {
  assert.equal(normalizeRemovedHandle("@Alice"), "alice");
});

test("resolveRemovalTarget requires handle or x_user_id and blocks self", () => {
  assert.equal(resolveRemovalTarget({}).ok, false);
  assert.deepEqual(resolveRemovalTarget({ handle: "bob", requesterHandle: "zndtoshi" }), {
    ok: true,
    handle: "bob",
    xUserId: null,
  });
  assert.equal(resolveRemovalTarget({ handle: "zndtoshi", requesterHandle: "@zndtoshi" }).ok, false);
});

test("filterOutRemovedCommunityUsers drops by handle or x_user_id", () => {
  const rows = [
    { handle: "keep", x_user_id: "1" },
    { handle: "gone", x_user_id: "2" },
    { handle: "other", x_user_id: "99" },
  ];
  const filtered = filterOutRemovedCommunityUsers(rows, {
    handles: new Set(["gone"]),
    xUserIds: new Set(["99"]),
  });
  assert.deepEqual(filtered.map((r) => r.handle), ["keep"]);
  assert.equal(
    isRemovedCommunityUser({ handle: "gone" }, { handles: new Set(["gone"]), xUserIds: new Set() }),
    true
  );
});
