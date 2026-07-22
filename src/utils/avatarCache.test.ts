import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetAvatarCacheForTests,
  canonicalAvatarSrc,
  getAvatarCacheSize,
  getAvatarLoadConcurrency,
  getAvatarPrioritized,
  preloadAvatarUrls,
  setAvatarLoadConcurrency,
} from "./avatarCache.js";

class FakeImage {
  static instances: FakeImage[] = [];
  src = "";
  complete = false;
  naturalWidth = 0;
  decoding = "async";
  referrerPolicy = "";
  loading = "";
  private listeners = new Map<string, Set<() => void>>();
  private attrs = new Map<string, string>();

  constructor() {
    FakeImage.instances.push(this);
  }

  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  getAttribute(name: string) {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  decode() {
    return Promise.resolve();
  }

  trigger(type: "load" | "error") {
    if (type === "load") {
      this.complete = true;
      this.naturalWidth = 32;
    }
    for (const fn of this.listeners.get(type) || []) fn();
  }
}

test("canonicalAvatarSrc strips hash and trims", () => {
  assert.equal(canonicalAvatarSrc("  /avatars/a.jpg#x  "), "/avatars/a.jpg");
});

test("getAvatarPrioritized dedupes concurrent requests for the same URL", () => {
  __resetAvatarCacheForTests();
  FakeImage.instances = [];
  const PrevImage = globalThis.Image;
  globalThis.Image = FakeImage as unknown as typeof Image;
  try {
    setAvatarLoadConcurrency(2);
    const a = getAvatarPrioritized("/avatars/one.jpg", 10);
    const b = getAvatarPrioritized("/avatars/one.jpg", 10);
    assert.equal(a, b);
    assert.equal(FakeImage.instances.length, 1);
    assert.equal(getAvatarCacheSize(), 1);
  } finally {
    globalThis.Image = PrevImage;
    __resetAvatarCacheForTests();
  }
});

test("preloadAvatarUrls respects concurrency bound", () => {
  __resetAvatarCacheForTests();
  FakeImage.instances = [];
  const PrevImage = globalThis.Image;
  globalThis.Image = FakeImage as unknown as typeof Image;
  try {
    setAvatarLoadConcurrency(2);
    assert.equal(getAvatarLoadConcurrency(), 2);
    preloadAvatarUrls(
      ["/avatars/a.jpg", "/avatars/b.jpg", "/avatars/c.jpg", "/avatars/d.jpg"],
      { priority: 20 }
    );
    // Only two should have src assigned while in-flight slots are full.
    const assigned = FakeImage.instances.filter((img) => img.getAttribute("data-ch-src") === "1");
    assert.ok(assigned.length <= 2);
    // Completing one should allow another to start.
    assigned[0]?.trigger("load");
    const assignedAfter = FakeImage.instances.filter((img) => img.getAttribute("data-ch-src") === "1");
    assert.ok(assignedAfter.length >= 2);
  } finally {
    globalThis.Image = PrevImage;
    __resetAvatarCacheForTests();
  }
});

test("failed avatar is not retried within failure TTL", () => {
  __resetAvatarCacheForTests();
  FakeImage.instances = [];
  const PrevImage = globalThis.Image;
  globalThis.Image = FakeImage as unknown as typeof Image;
  try {
    setAvatarLoadConcurrency(4);
    const img = getAvatarPrioritized("/avatars/missing.jpg", 5) as unknown as FakeImage;
    img.trigger("error");
    const again = getAvatarPrioritized("/avatars/missing.jpg", 5) as unknown as FakeImage;
    // Failure cache returns the empty placeholder, not the failed network Image,
    // and does not enqueue another network assign for the same URL.
    assert.notEqual(again, img);
    assert.notEqual(again.getAttribute("data-ch-src"), "1");
    const networkAssigned = FakeImage.instances.filter((i) => i.getAttribute("data-ch-src") === "1");
    assert.equal(networkAssigned.length, 1);
  } finally {
    globalThis.Image = PrevImage;
    __resetAvatarCacheForTests();
  }
});
