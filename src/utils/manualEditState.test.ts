import test from "node:test";
import assert from "node:assert/strict";
import { applyManualStanceUpdate, isPrivilegedManualEditor } from "./manualEditState";

test("privileged manual editor is only zndtoshi", () => {
  assert.equal(isPrivilegedManualEditor("zndtoshi"), true);
  assert.equal(isPrivilegedManualEditor("@zndtoshi"), true);
  assert.equal(isPrivilegedManualEditor("ZndToshi "), true);
  assert.equal(isPrivilegedManualEditor("someone_else"), false);
});

test("manual stance update preserves profile stats and avatar", () => {
  const original = [
    {
      handle: "niftynei",
      followers_count: 12345,
      avatar_url: "https://pbs.twimg.com/profile_images/x.jpg",
      avatar_path: "/avatars/niftynei.jpg",
      stance: "approve",
      name: "Nifty",
    },
  ];
  const updated = applyManualStanceUpdate(original, "niftynei", "against");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.stance, "against");
  assert.equal(updated[0]?.followers_count, 12345);
  assert.equal(updated[0]?.avatar_url, "https://pbs.twimg.com/profile_images/x.jpg");
  assert.equal(updated[0]?.avatar_path, "/avatars/niftynei.jpg");
  assert.equal(updated[0]?.name, "Nifty");
});

test("manual stance update changes only matching handle", () => {
  const original = [
    { handle: "alice", followers_count: 10, stance: "neutral" },
    { handle: "bob", followers_count: 20, stance: "approve" },
  ];
  const updated = applyManualStanceUpdate(original, "bob", "against");
  assert.equal(updated[0]?.stance, "neutral");
  assert.equal(updated[1]?.stance, "against");
  assert.equal(updated[1]?.followers_count, 20);
});
