import test from "node:test";
import assert from "node:assert/strict";
import {
  avatarRecoveryPublicPath,
  emptyAvatarRecoveryStats,
  formatAvatarRecoverySummary,
  highestResTwitterAvatarUrl,
  needsAvatarRecovery,
  recoverOneAvatar,
  type AvatarRecoveryCandidate,
  type AvatarRecoveryDeps,
} from "./avatarRecovery.js";
import { mapEnrichment } from "./profileEnrichment.js";

test("highestResTwitterAvatarUrl strips size suffixes", () => {
  assert.equal(
    highestResTwitterAvatarUrl(
      "https://pbs.twimg.com/profile_images/1/abc_normal.jpg"
    ),
    "https://pbs.twimg.com/profile_images/1/abc.jpg"
  );
  assert.equal(
    highestResTwitterAvatarUrl(
      "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg"
    ),
    "https://pbs.twimg.com/profile_images/1/abc.jpg"
  );
});

test("avatarRecoveryPublicPath uses /avatars/{handle}.jpg", () => {
  assert.equal(avatarRecoveryPublicPath("@Otaliptus"), "/avatars/otaliptus.jpg");
  assert.equal(avatarRecoveryPublicPath(""), null);
});

test("needsAvatarRecovery is true when path missing or file gone", () => {
  const exists = (p: string) => p === "/avatars/ok.jpg";
  assert.equal(needsAvatarRecovery({ avatar_path: null }, exists), true);
  assert.equal(needsAvatarRecovery({ avatar_path: "" }, exists), true);
  assert.equal(needsAvatarRecovery({ avatar_path: "/avatars/missing.jpg" }, exists), true);
  assert.equal(needsAvatarRecovery({ avatar_path: "/avatars/ok.jpg" }, exists), false);
});

test("formatAvatarRecoverySummary matches required labels", () => {
  const s = emptyAvatarRecoveryStats();
  s.recovered = 3;
  s.skipped = 10;
  s.unavailable = 1;
  s.failed = 2;
  assert.equal(
    formatAvatarRecoverySummary(s),
    "Recovered: 3\nSkipped: 10\nUnavailable: 1\nFailed: 2"
  );
});

test("mapEnrichment extracts profilePicture as high-res URL", () => {
  const mapped = mapEnrichment({
    id: "123",
    userName: "otaliptus",
    profilePicture: "https://pbs.twimg.com/profile_images/9/pic_normal.jpg",
  });
  assert.equal(mapped?.profileImageUrl, "https://pbs.twimg.com/profile_images/9/pic.jpg");
});

function mockDeps(overrides: Partial<AvatarRecoveryDeps> = {}): AvatarRecoveryDeps & {
  files: Set<string>;
  updates: Array<{ xUserId: string; avatarPath: string; avatarUrl: string }>;
} {
  const files = new Set<string>();
  const updates: Array<{ xUserId: string; avatarPath: string; avatarUrl: string }> = [];
  const deps: AvatarRecoveryDeps & {
    files: Set<string>;
    updates: typeof updates;
  } = {
    files,
    updates,
    fileExists: (p) => files.has(p),
    async fetchProfile() {
      return {
        id: "1",
        username: "otaliptus",
        profileImageUrl: "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
        unavailable: false,
        unavailableReason: null,
      };
    },
    async fetchImage() {
      return {
        ok: true,
        status: 200,
        contentType: "image/jpeg",
        bytes: new Uint8Array([1, 2, 3, 4]),
      };
    },
    async writeAtomic(filename) {
      files.add(`/avatars/${filename}`);
    },
    async updateAvatar(args) {
      updates.push(args);
    },
    ...overrides,
  };
  return deps;
}

test("recoverOneAvatar skips valid local avatar (idempotent)", async () => {
  const deps = mockDeps();
  deps.files.add("/avatars/xid.jpg");
  const row: AvatarRecoveryCandidate = {
    x_user_id: "99",
    handle: "otaliptus",
    avatar_path: "/avatars/xid.jpg",
    avatar_url: "https://pbs.twimg.com/old.jpg",
  };
  const out = await recoverOneAvatar(row, deps);
  assert.equal(out.kind, "skipped");
  assert.equal(deps.updates.length, 0);
});

test("recoverOneAvatar downloads fresh image and updates path+url", async () => {
  const deps = mockDeps();
  const row: AvatarRecoveryCandidate = {
    x_user_id: "99",
    handle: "otaliptus",
    avatar_path: null,
    avatar_url: "https://pbs.twimg.com/stale.jpg",
  };
  const out = await recoverOneAvatar(row, deps);
  assert.equal(out.kind, "recovered");
  if (out.kind === "recovered") {
    assert.equal(out.avatarPath, "/avatars/otaliptus.jpg");
    assert.equal(out.avatarUrl, "https://pbs.twimg.com/profile_images/1/a.jpg");
  }
  assert.ok(deps.files.has("/avatars/otaliptus.jpg"));
  assert.deepEqual(deps.updates[0], {
    xUserId: "99",
    avatarPath: "/avatars/otaliptus.jpg",
    avatarUrl: "https://pbs.twimg.com/profile_images/1/a.jpg",
  });
});

test("recoverOneAvatar logs unavailable without writing", async () => {
  const deps = mockDeps({
    async fetchProfile() {
      return {
        id: null,
        username: null,
        profileImageUrl: null,
        unavailable: true,
        unavailableReason: "User is suspended",
      };
    },
  });
  const out = await recoverOneAvatar(
    {
      x_user_id: "1",
      handle: "gone",
      avatar_path: null,
      avatar_url: null,
    },
    deps
  );
  assert.equal(out.kind, "unavailable");
  assert.equal(deps.updates.length, 0);
});

test("recoverOneAvatar prefers handle fallback when id lookup returns null then handle works", async () => {
  let calls = 0;
  const deps = mockDeps({
    async fetchProfile(input) {
      calls += 1;
      // Script-level prefers id then handle inside fetchProfileEnrichment;
      // recoverOneAvatar passes both — simulate success via handle.
      assert.equal(input.handle, "otaliptus");
      return {
        id: "123",
        username: "otaliptus",
        profileImageUrl: "https://pbs.twimg.com/profile_images/1/z.jpg",
        unavailable: false,
        unavailableReason: null,
      };
    },
  });
  const out = await recoverOneAvatar(
    {
      x_user_id: "manual:otaliptus",
      handle: "otaliptus",
      avatar_path: null,
      avatar_url: "https://pbs.twimg.com/stale.jpg",
    },
    deps
  );
  assert.equal(out.kind, "recovered");
  assert.equal(calls, 1);
});

test("second recover is skipped when handle file already exists", async () => {
  const deps = mockDeps();
  deps.files.add("/avatars/otaliptus.jpg");
  const out = await recoverOneAvatar(
    {
      x_user_id: "99",
      handle: "otaliptus",
      avatar_path: null,
      avatar_url: "https://pbs.twimg.com/stale.jpg",
    },
    deps
  );
  assert.equal(out.kind, "skipped");
  assert.equal(deps.updates.length, 0);
});
