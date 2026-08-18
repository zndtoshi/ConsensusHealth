import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  avatarExtForContentType,
  avatarPublicPath,
  avatarRevisionFromBytes,
  createEnsureLocalAvatar,
  isOwnedAvatarPath,
  resolveAvatarsDir,
  type AvatarStorageDeps,
  type FetchedAvatar,
} from "./avatarStorage.js";

type FakeUserRow = {
  avatar_path: string | null;
  avatar_url: string | null;
  avatar_source_url?: string | null;
};

type FakeState = {
  db: Map<string, FakeUserRow>;
  files: Set<string>; // public paths that "exist"
  fetchCalls: number;
  writeCalls: number;
  setPathCalls: number;
  deletedPaths: string[];
  fetchResult: FetchedAvatar | null;
  fetchDelayMs: number;
};

function makeDeps(state: FakeState): AvatarStorageDeps {
  return {
    async getUser(xUserId) {
      return state.db.get(xUserId) ?? null;
    },
    fileExists(publicPath) {
      return state.files.has(publicPath);
    },
    async writeAtomic(filename) {
      state.writeCalls++;
      state.files.add(`/avatars/${filename}`);
    },
    async fetchImage() {
      state.fetchCalls++;
      if (state.fetchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, state.fetchDelayMs));
      }
      return state.fetchResult;
    },
    async setAvatarPath(xUserId, avatarPath, sourceUrl) {
      state.setPathCalls++;
      const existing = state.db.get(xUserId) ?? { avatar_path: null, avatar_url: null };
      state.db.set(xUserId, {
        ...existing,
        avatar_path: avatarPath,
        avatar_source_url: sourceUrl || null,
      });
    },
    async deleteFile(publicPath) {
      state.deletedPaths.push(publicPath);
      state.files.delete(publicPath);
    },
  };
}

/** Distinct byte patterns so content hashes (and therefore paths) differ. */
function imageBytes(fill: number, size = 128): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function jpegResult(bytes: Uint8Array | number = imageBytes(1)): FetchedAvatar {
  const body = typeof bytes === "number" ? imageBytes(1, bytes) : bytes;
  return { ok: true, status: 200, contentType: "image/jpeg", bytes: body };
}

/** Expected public path for a fetch result, mirroring the storage naming rule. */
function expectedPath(xUserId: string, ext: string, bytes: Uint8Array): string {
  return avatarPublicPath(xUserId, ext, avatarRevisionFromBytes(bytes));
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    db: new Map(),
    files: new Set(),
    fetchCalls: 0,
    writeCalls: 0,
    setPathCalls: 0,
    deletedPaths: [],
    fetchResult: jpegResult(),
    fetchDelayMs: 0,
    ...overrides,
  };
}

test("avatarExtForContentType maps image types and rejects others", () => {
  assert.equal(avatarExtForContentType("image/jpeg"), "jpg");
  assert.equal(avatarExtForContentType("image/png; charset=binary"), "png");
  assert.equal(avatarExtForContentType("image/webp"), "webp");
  assert.equal(avatarExtForContentType("text/html"), null);
  assert.equal(avatarExtForContentType(null), null);
});

test("resolveAvatarsDir honors env override, else prod/dev defaults", () => {
  assert.equal(
    resolveAvatarsDir({ envDir: "/data/avatars", isProd: true, distPath: "/app/dist", cwd: "/app" }),
    path.resolve("/data/avatars")
  );
  assert.equal(
    resolveAvatarsDir({ isProd: true, distPath: "/app/dist", cwd: "/app" }),
    path.join("/app/dist", "avatars")
  );
  assert.equal(
    resolveAvatarsDir({ isProd: false, distPath: "/app/dist", cwd: "/app" }),
    path.join("/app", "public", "avatars")
  );
});

test("unchanged avatar URL with a local file makes no remote request", async () => {
  const state = baseState();
  state.db.set("42", {
    avatar_path: "/avatars/42.jpg",
    avatar_url: "https://pbs.twimg.com/a.jpg",
    avatar_source_url: "https://pbs.twimg.com/a.jpg",
  });
  state.files.add("/avatars/42.jpg");
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/a.jpg" });

  assert.equal(result, "/avatars/42.jpg");
  assert.equal(state.fetchCalls, 0);
  assert.equal(state.writeCalls, 0);
  assert.equal(state.setPathCalls, 0);
  assert.deepEqual(state.deletedPaths, []);
});

test("missing avatar is downloaded once, stored, and recorded in the DB", async () => {
  const bytes = imageBytes(1);
  const state = baseState({ fetchResult: jpegResult(bytes) });
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42" });

  const wanted = expectedPath("42", "jpg", bytes);
  assert.equal(result, wanted);
  assert.equal(state.fetchCalls, 1);
  assert.equal(state.writeCalls, 1);
  assert.equal(state.setPathCalls, 1);
  assert.equal(state.db.get("42")?.avatar_path, wanted);
  // The URL that produced the file is recorded so later logins can compare.
  assert.equal(state.db.get("42")?.avatar_source_url, "https://pbs.twimg.com/a.jpg");
});

test("subsequent calls with the same URL do not make another remote request", async () => {
  const state = baseState();
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const first = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/a.jpg" });
  const second = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/a.jpg" });

  assert.equal(second, first);
  assert.equal(state.fetchCalls, 1); // only the first call fetched
  assert.equal(state.writeCalls, 1);
});

test("failed download returns null and leaves placeholder behavior intact", async () => {
  const state = baseState({ fetchResult: { ok: false, status: 404, contentType: null, bytes: new Uint8Array() } });
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/gone.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42" });

  assert.equal(result, null);
  assert.equal(state.writeCalls, 0);
  assert.equal(state.setPathCalls, 0);
  assert.equal(state.db.get("42")?.avatar_path ?? null, null);
});

test("unsupported content type is rejected without saving", async () => {
  const state = baseState({ fetchResult: { ok: true, status: 200, contentType: "text/html", bytes: new Uint8Array(10) } });
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42" });
  assert.equal(result, null);
  assert.equal(state.writeCalls, 0);
});

test("oversized download is rejected without saving", async () => {
  const state = baseState({ fetchResult: jpegResult(6 * 1024 * 1024) });
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42" });
  assert.equal(result, null);
  assert.equal(state.writeCalls, 0);
});

test("no remote url means nothing to fetch (placeholder stays)", async () => {
  const state = baseState();
  state.db.set("42", { avatar_path: null, avatar_url: null });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42" });
  assert.equal(result, null);
  assert.equal(state.fetchCalls, 0);
});

test("concurrent calls for the same user only fetch and save once", async () => {
  const bytes = imageBytes(1);
  const state = baseState({ fetchDelayMs: 25, fetchResult: jpegResult(bytes) });
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const [a, b, c] = await Promise.all([
    ensure({ x_user_id: "42" }),
    ensure({ x_user_id: "42" }),
    ensure({ x_user_id: "42" }),
  ]);

  const wanted = expectedPath("42", "jpg", bytes);
  assert.equal(a, wanted);
  assert.equal(b, wanted);
  assert.equal(c, wanted);
  assert.equal(state.fetchCalls, 1);
  assert.equal(state.writeCalls, 1);
  assert.equal(state.setPathCalls, 1);
});

test("a re-download uses the ext from content type (png)", async () => {
  const bytes = imageBytes(7, 64);
  const state = baseState({
    fetchResult: { ok: true, status: 200, contentType: "image/png", bytes },
  });
  state.db.set("99", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.png" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "99" });
  assert.equal(result, expectedPath("99", "png", bytes));
});

test("changed avatar URL refreshes to a new cache-busting path", async () => {
  const oldBytes = imageBytes(1);
  const newBytes = imageBytes(2);
  const state = baseState({ fetchResult: jpegResult(newBytes) });
  const oldPath = expectedPath("42", "jpg", oldBytes);
  state.db.set("42", {
    avatar_path: oldPath,
    avatar_url: "https://pbs.twimg.com/new.jpg",
    avatar_source_url: "https://pbs.twimg.com/old.jpg",
  });
  state.files.add(oldPath);
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" });

  const newPath = expectedPath("42", "jpg", newBytes);
  assert.equal(result, newPath);
  assert.notEqual(newPath, oldPath); // immutable /avatars caching is defeated
  assert.equal(state.fetchCalls, 1);
  assert.equal(state.db.get("42")?.avatar_path, newPath);
  assert.equal(state.db.get("42")?.avatar_source_url, "https://pbs.twimg.com/new.jpg");
  // Superseded file cleaned up only after the DB points at the new one.
  assert.deepEqual(state.deletedPaths, [oldPath]);
});

test("refresh returning identical bytes keeps the same path and file", async () => {
  const bytes = imageBytes(1);
  const state = baseState({ fetchResult: jpegResult(bytes) });
  const existing = expectedPath("42", "jpg", bytes);
  state.db.set("42", {
    avatar_path: existing,
    avatar_url: "https://pbs.twimg.com/new.jpg",
    avatar_source_url: "https://pbs.twimg.com/old.jpg",
  });
  state.files.add(existing);
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" });

  assert.equal(result, existing);
  assert.deepEqual(state.deletedPaths, []); // nothing superseded
  assert.ok(state.files.has(existing));
  assert.equal(state.db.get("42")?.avatar_source_url, "https://pbs.twimg.com/new.jpg");
});

test("avatar captured before source tracking refreshes once, then settles", async () => {
  const newBytes = imageBytes(3);
  const state = baseState({ fetchResult: jpegResult(newBytes) });
  state.db.set("42", {
    avatar_path: "/avatars/42.jpg",
    avatar_url: "https://pbs.twimg.com/a.jpg",
    avatar_source_url: null, // legacy row: unknown provenance
  });
  state.files.add("/avatars/42.jpg");
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const first = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/a.jpg" });
  const second = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/a.jpg" });

  assert.equal(first, expectedPath("42", "jpg", newBytes));
  assert.equal(second, first);
  assert.equal(state.fetchCalls, 1); // second login compares and skips
  assert.deepEqual(state.deletedPaths, ["/avatars/42.jpg"]);
});

test("failed refresh preserves the existing avatar path and file", async () => {
  const oldBytes = imageBytes(1);
  const state = baseState({
    fetchResult: { ok: false, status: 500, contentType: null, bytes: new Uint8Array() },
  });
  const oldPath = expectedPath("42", "jpg", oldBytes);
  state.db.set("42", {
    avatar_path: oldPath,
    avatar_url: "https://pbs.twimg.com/new.jpg",
    avatar_source_url: "https://pbs.twimg.com/old.jpg",
  });
  state.files.add(oldPath);
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" });

  assert.equal(result, oldPath);
  assert.equal(state.writeCalls, 0);
  assert.equal(state.setPathCalls, 0);
  assert.equal(state.db.get("42")?.avatar_path, oldPath);
  assert.ok(state.files.has(oldPath));
  assert.deepEqual(state.deletedPaths, []);
});

test("a database write failure during refresh leaves the old path intact", async () => {
  const oldBytes = imageBytes(1);
  const state = baseState({ fetchResult: jpegResult(imageBytes(2)) });
  const oldPath = expectedPath("42", "jpg", oldBytes);
  state.db.set("42", {
    avatar_path: oldPath,
    avatar_url: "https://pbs.twimg.com/new.jpg",
    avatar_source_url: "https://pbs.twimg.com/old.jpg",
  });
  state.files.add(oldPath);
  const deps = makeDeps(state);
  const ensure = createEnsureLocalAvatar({
    ...deps,
    async setAvatarPath() {
      throw new Error("db down");
    },
  });

  const result = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" });

  assert.equal(result, oldPath);
  assert.equal(state.db.get("42")?.avatar_path, oldPath);
  assert.ok(state.files.has(oldPath)); // never deleted before the DB moved
  assert.deepEqual(state.deletedPaths, []);
});

test("cleanup failure does not break an otherwise successful refresh", async () => {
  const newBytes = imageBytes(2);
  const state = baseState({ fetchResult: jpegResult(newBytes) });
  const oldPath = expectedPath("42", "jpg", imageBytes(1));
  state.db.set("42", {
    avatar_path: oldPath,
    avatar_url: "https://pbs.twimg.com/new.jpg",
    avatar_source_url: "https://pbs.twimg.com/old.jpg",
  });
  state.files.add(oldPath);
  const deps = makeDeps(state);
  const ensure = createEnsureLocalAvatar({
    ...deps,
    async deleteFile() {
      throw new Error("read-only volume");
    },
  });

  const result = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" });

  assert.equal(result, expectedPath("42", "jpg", newBytes));
  assert.equal(state.db.get("42")?.avatar_path, result);
});

test("concurrent refresh for the same user downloads once", async () => {
  const newBytes = imageBytes(2);
  const state = baseState({ fetchDelayMs: 25, fetchResult: jpegResult(newBytes) });
  const oldPath = expectedPath("42", "jpg", imageBytes(1));
  state.db.set("42", {
    avatar_path: oldPath,
    avatar_url: "https://pbs.twimg.com/new.jpg",
    avatar_source_url: "https://pbs.twimg.com/old.jpg",
  });
  state.files.add(oldPath);
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const results = await Promise.all([
    ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" }),
    ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" }),
    ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" }),
  ]);

  const newPath = expectedPath("42", "jpg", newBytes);
  assert.deepEqual(results, [newPath, newPath, newPath]);
  assert.equal(state.fetchCalls, 1);
  assert.equal(state.writeCalls, 1);
  assert.equal(state.setPathCalls, 1);
  assert.deepEqual(state.deletedPaths, [oldPath]); // one consistent cleanup
});

test("a seed avatar is replaced but never deleted", async () => {
  const newBytes = imageBytes(4);
  const state = baseState({ fetchResult: jpegResult(newBytes) });
  state.db.set("42", {
    avatar_path: "/avatars/zndtoshi.jpg", // handle-named seed file in the repo
    avatar_url: "https://pbs.twimg.com/new.jpg",
    avatar_source_url: null,
  });
  state.files.add("/avatars/zndtoshi.jpg");
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42", avatar_url: "https://pbs.twimg.com/new.jpg" });

  assert.equal(result, expectedPath("42", "jpg", newBytes));
  assert.deepEqual(state.deletedPaths, []);
  assert.ok(state.files.has("/avatars/zndtoshi.jpg"));
});

test("isOwnedAvatarPath only claims this user's own capture filenames", () => {
  assert.equal(isOwnedAvatarPath("/avatars/42.jpg", "42"), true);
  assert.equal(isOwnedAvatarPath("/avatars/42-a1b2c3d4e5.jpg", "42"), true);
  assert.equal(isOwnedAvatarPath("/avatars/zndtoshi.jpg", "42"), false);
  assert.equal(isOwnedAvatarPath("/avatars/421.jpg", "42"), false);
  assert.equal(isOwnedAvatarPath("/avatars/4.jpg", "42"), false);
  assert.equal(isOwnedAvatarPath("/avatars/../secret.jpg", "42"), false);
  assert.equal(isOwnedAvatarPath("/other/42.jpg", "42"), false);
  assert.equal(isOwnedAvatarPath("", "42"), false);
});

test("avatarRevisionFromBytes is stable per content and differs across content", () => {
  const a = avatarRevisionFromBytes(imageBytes(1));
  const b = avatarRevisionFromBytes(imageBytes(1));
  const c = avatarRevisionFromBytes(imageBytes(2));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{10}$/);
});

test("avatarPublicPath keeps the legacy shape without a revision", () => {
  assert.equal(avatarPublicPath("42", "jpg"), "/avatars/42.jpg");
  assert.equal(avatarPublicPath("42", "jpg", null), "/avatars/42.jpg");
  assert.equal(avatarPublicPath("42", "jpg", "abc123"), "/avatars/42-abc123.jpg");
});
