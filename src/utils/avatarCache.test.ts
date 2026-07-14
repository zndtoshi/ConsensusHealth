import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  __resetAvatarCacheForTests,
  __setAvatarImageFactoryForTests,
  canonicalAvatarSrc,
  getAvatar,
  hasAvatarLoaded,
  isAvatarUrlFailed,
  preloadAvatarUrls,
  type AvatarImageLike,
} from "./avatarCache.js";

type Listeners = { load: Array<() => void>; error: Array<() => void> };

class FakeImage implements AvatarImageLike {
  src = "";
  decoding = "";
  loading = "";
  referrerPolicy = "";
  complete = false;
  naturalWidth = 0;
  listeners: Listeners = { load: [], error: [] };
  addEventListener(type: string, listener: () => void) {
    if (type === "load") this.listeners.load.push(listener);
    if (type === "error") this.listeners.error.push(listener);
  }
  fireLoad() {
    this.complete = true;
    this.naturalWidth = 200;
    for (const l of this.listeners.load) l();
  }
  fireError() {
    this.complete = true;
    this.naturalWidth = 0;
    for (const l of this.listeners.error) l();
  }
}

let created: FakeImage[] = [];

beforeEach(() => {
  created = [];
  __setAvatarImageFactoryForTests(() => {
    const img = new FakeImage();
    created.push(img);
    return img;
  });
  __resetAvatarCacheForTests();
});

test("canonicalAvatarSrc dedups by stripping the hash", () => {
  assert.equal(canonicalAvatarSrc("/avatars/1#x"), canonicalAvatarSrc("/avatars/1"));
  assert.equal(canonicalAvatarSrc("  /avatars/1  "), "/avatars/1");
});

test("getAvatar deduplicates concurrent loads of the same URL (one Image, one request)", () => {
  const a = getAvatar("/avatars/1");
  const b = getAvatar("/avatars/1");
  const c = getAvatar("/avatars/1#ignored-hash");
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(created.length, 1);
  assert.equal(a.src, "/avatars/1");
  assert.equal(a.decoding, "async");
  assert.equal(a.referrerPolicy, "no-referrer");
});

test("getAvatar creates distinct Images for distinct URLs", () => {
  getAvatar("/avatars/1");
  getAvatar("/avatars/2");
  assert.equal(created.length, 2);
});

test("preloadAvatarUrls dedupes and does not create duplicate Images", () => {
  preloadAvatarUrls(["/avatars/1", "/avatars/1", "/avatars/2", "  ", "/avatars/2"]);
  assert.equal(created.length, 2);
});

test("failed image URL is recorded for the session", () => {
  const img = getAvatar("/avatars/broken") as unknown as FakeImage;
  assert.equal(isAvatarUrlFailed("/avatars/broken"), false);
  img.fireError();
  assert.equal(isAvatarUrlFailed("/avatars/broken"), true);
  assert.equal(hasAvatarLoaded("/avatars/broken"), false);
});

test("successful image URL is recorded for the session", () => {
  const img = getAvatar("/avatars/ok") as unknown as FakeImage;
  img.fireLoad();
  assert.equal(hasAvatarLoaded("/avatars/ok"), true);
  assert.equal(isAvatarUrlFailed("/avatars/ok"), false);
});
