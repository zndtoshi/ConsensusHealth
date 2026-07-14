import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  avatarExtForContentType,
  createEnsureLocalAvatar,
  resolveAvatarsDir,
  type AvatarStorageDeps,
  type FetchedAvatar,
} from "./avatarStorage.js";

type FakeState = {
  db: Map<string, { avatar_path: string | null; avatar_url: string | null }>;
  files: Set<string>; // public paths that "exist"
  fetchCalls: number;
  writeCalls: number;
  setPathCalls: number;
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
    async setAvatarPath(xUserId, avatarPath) {
      state.setPathCalls++;
      const existing = state.db.get(xUserId) ?? { avatar_path: null, avatar_url: null };
      state.db.set(xUserId, { ...existing, avatar_path: avatarPath });
    },
  };
}

function jpegResult(bytes = 128): FetchedAvatar {
  return { ok: true, status: 200, contentType: "image/jpeg", bytes: new Uint8Array(bytes) };
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    db: new Map(),
    files: new Set(),
    fetchCalls: 0,
    writeCalls: 0,
    setPathCalls: 0,
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

test("existing valid local avatar is returned and never overwritten", async () => {
  const state = baseState();
  state.db.set("42", { avatar_path: "/avatars/42.jpg", avatar_url: "https://pbs.twimg.com/a.jpg" });
  state.files.add("/avatars/42.jpg");
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42" });

  assert.equal(result, "/avatars/42.jpg");
  assert.equal(state.fetchCalls, 0);
  assert.equal(state.writeCalls, 0);
  assert.equal(state.setPathCalls, 0);
});

test("missing avatar is downloaded once, stored, and recorded in the DB", async () => {
  const state = baseState();
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "42" });

  assert.equal(result, "/avatars/42.jpg");
  assert.equal(state.fetchCalls, 1);
  assert.equal(state.writeCalls, 1);
  assert.equal(state.setPathCalls, 1);
  assert.equal(state.db.get("42")?.avatar_path, "/avatars/42.jpg");
});

test("subsequent calls do not make another remote request", async () => {
  const state = baseState();
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const first = await ensure({ x_user_id: "42" });
  const second = await ensure({ x_user_id: "42" });

  assert.equal(first, "/avatars/42.jpg");
  assert.equal(second, "/avatars/42.jpg");
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
  const state = baseState({ fetchDelayMs: 25 });
  state.db.set("42", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.jpg" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const [a, b, c] = await Promise.all([
    ensure({ x_user_id: "42" }),
    ensure({ x_user_id: "42" }),
    ensure({ x_user_id: "42" }),
  ]);

  assert.equal(a, "/avatars/42.jpg");
  assert.equal(b, "/avatars/42.jpg");
  assert.equal(c, "/avatars/42.jpg");
  assert.equal(state.fetchCalls, 1);
  assert.equal(state.writeCalls, 1);
  assert.equal(state.setPathCalls, 1);
});

test("a re-download uses the ext from content type (png)", async () => {
  const state = baseState({ fetchResult: { ok: true, status: 200, contentType: "image/png", bytes: new Uint8Array(64) } });
  state.db.set("99", { avatar_path: null, avatar_url: "https://pbs.twimg.com/a.png" });
  const ensure = createEnsureLocalAvatar(makeDeps(state));

  const result = await ensure({ x_user_id: "99" });
  assert.equal(result, "/avatars/99.png");
});
