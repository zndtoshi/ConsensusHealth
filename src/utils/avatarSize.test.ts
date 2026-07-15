import test from "node:test";
import assert from "node:assert/strict";
import { followersForAvatarSize } from "./avatarSize.js";

test("known zero followers sizes as minimum, not seed stance fallback", () => {
  assert.equal(
    followersForAvatarSize({ followers: 0, source: "followers_count" }, true),
    0
  );
});

test("known positive followers are used directly", () => {
  assert.equal(
    followersForAvatarSize({ followers: 842, source: "profile" }, true),
    842
  );
});

test("missing follower data with seed stance uses moderate fallback", () => {
  assert.equal(
    followersForAvatarSize({ followers: 0, source: "none" }, true),
    5000
  );
});

test("missing follower data without seed stance uses zero", () => {
  assert.equal(
    followersForAvatarSize({ followers: 0, source: "none" }, false),
    0
  );
});
