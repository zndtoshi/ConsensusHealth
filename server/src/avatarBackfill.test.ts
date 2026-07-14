import assert from "node:assert/strict";
import { test } from "node:test";
import { clampConcurrency, runAvatarBackfill, type AvatarBackfillCandidate } from "./avatarBackfill.js";
import type { EnsureAvatarResult } from "./avatarStore.js";

const silentLogger = { log() {}, warn() {}, error() {} };

function candidate(x_user_id: string, avatar_url: string | null = "https://pbs.twimg.com/x_normal.jpg"): AvatarBackfillCandidate {
  return { x_user_id, avatar_url };
}

test("clampConcurrency keeps values within 1..5 with a sane default", () => {
  assert.equal(clampConcurrency(undefined), 4);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(3), 3);
  assert.equal(clampConcurrency(50), 5);
  assert.equal(clampConcurrency(Number.NaN), 4);
});

test("skips candidates whose blob already exists", async () => {
  const seen: string[] = [];
  const ensure = async (id: string): Promise<EnsureAvatarResult> => {
    seen.push(id);
    return { status: "exists" };
  };
  const stats = await runAvatarBackfill({
    candidates: [candidate("1"), candidate("2")],
    ensure,
    logger: silentLogger,
  });
  assert.deepEqual(stats, { total: 2, stored: 0, skipped: 2, failed: 0 });
  assert.deepEqual(seen.sort(), ["1", "2"]);
});

test("stores candidates that are missing a blob", async () => {
  const ensure = async (): Promise<EnsureAvatarResult> => ({ status: "stored" });
  const stats = await runAvatarBackfill({
    candidates: [candidate("1"), candidate("2"), candidate("3")],
    ensure,
    logger: silentLogger,
  });
  assert.deepEqual(stats, { total: 3, stored: 3, skipped: 0, failed: 0 });
});

test("continues after a single failure (thrown and returned)", async () => {
  const ensure = async (id: string): Promise<EnsureAvatarResult> => {
    if (id === "2") throw new Error("boom");
    if (id === "3") return { status: "failed", reason: "bad_status" };
    return { status: "stored" };
  };
  const stats = await runAvatarBackfill({
    candidates: [candidate("1"), candidate("2"), candidate("3"), candidate("4")],
    ensure,
    concurrency: 1,
    logger: silentLogger,
  });
  assert.equal(stats.total, 4);
  assert.equal(stats.stored, 2, "candidates 1 and 4 stored despite failures");
  assert.equal(stats.failed, 2, "one thrown + one returned failure");
  assert.equal(stats.skipped, 0);
});

test("respects the concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const ensure = async (): Promise<EnsureAvatarResult> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return { status: "stored" };
  };
  const candidates = Array.from({ length: 12 }, (_, i) => candidate(String(i)));
  const stats = await runAvatarBackfill({ candidates, ensure, concurrency: 3, logger: silentLogger });
  assert.equal(stats.stored, 12);
  assert.ok(maxActive <= 3, `expected at most 3 concurrent, saw ${maxActive}`);
  assert.ok(maxActive >= 2, `expected real parallelism, saw ${maxActive}`);
});

test("treats missing/invalid remote URL as skipped, not failed", async () => {
  const ensure = async (_id: string, url: string | null): Promise<EnsureAvatarResult> => {
    return url ? { status: "stored" } : { status: "skipped_no_url" };
  };
  const stats = await runAvatarBackfill({
    candidates: [candidate("1", null), candidate("2", ""), candidate("3")],
    ensure,
    logger: silentLogger,
  });
  assert.equal(stats.total, 3);
  assert.equal(stats.skipped, 2, "null and empty URLs are skipped");
  assert.equal(stats.stored, 1);
  assert.equal(stats.failed, 0);
});

test("skips candidates with a blank x_user_id without calling ensure", async () => {
  let calls = 0;
  const ensure = async (): Promise<EnsureAvatarResult> => {
    calls += 1;
    return { status: "stored" };
  };
  const stats = await runAvatarBackfill({
    candidates: [{ x_user_id: "   ", avatar_url: "https://pbs.twimg.com/x_normal.jpg" }, candidate("2")],
    ensure,
    logger: silentLogger,
  });
  assert.equal(calls, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.stored, 1);
});
