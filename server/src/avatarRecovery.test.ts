import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampRecoveryConcurrency,
  runAvatarRecovery,
  type AvatarRecoveryCandidate,
  type AvatarRecoveryOutcome,
} from "./avatarRecovery.js";

const silentLogger = { log() {}, warn() {}, error() {} };
const noSleep = async () => {};

function candidate(id: string, handle = `h${id}`): AvatarRecoveryCandidate {
  return { x_user_id: id, handle };
}

test("clampRecoveryConcurrency keeps values within 1..5 (default 3)", () => {
  assert.equal(clampRecoveryConcurrency(undefined), 3);
  assert.equal(clampRecoveryConcurrency(0), 1);
  assert.equal(clampRecoveryConcurrency(2), 2);
  assert.equal(clampRecoveryConcurrency(99), 5);
  assert.equal(clampRecoveryConcurrency(Number.NaN), 3);
});

test("classifies stored/exists/skipped/failed outcomes", async () => {
  const recoverOne = async (c: AvatarRecoveryCandidate): Promise<AvatarRecoveryOutcome> => {
    if (c.x_user_id === "1") return { status: "stored" };
    if (c.x_user_id === "2") return { status: "exists" };
    if (c.x_user_id === "3") return { status: "skipped", reason: "no_url" };
    return { status: "failed", reason: "blocked" };
  };
  const stats = await runAvatarRecovery({
    candidates: [candidate("1"), candidate("2"), candidate("3"), candidate("4")],
    recoverOne,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.deepEqual(stats, { total: 4, stored: 1, exists: 1, skipped: 1, failed: 1 });
});

test("continues past a thrown error", async () => {
  const recoverOne = async (c: AvatarRecoveryCandidate): Promise<AvatarRecoveryOutcome> => {
    if (c.x_user_id === "2") throw new Error("boom");
    return { status: "stored" };
  };
  const stats = await runAvatarRecovery({
    candidates: [candidate("1"), candidate("2"), candidate("3")],
    recoverOne,
    concurrency: 1,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(stats.stored, 2);
  assert.equal(stats.failed, 1);
});

test("respects the concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const recoverOne = async (): Promise<AvatarRecoveryOutcome> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return { status: "stored" };
  };
  const candidates = Array.from({ length: 12 }, (_, i) => candidate(String(i)));
  const stats = await runAvatarRecovery({
    candidates,
    recoverOne,
    concurrency: 3,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(stats.stored, 12);
  assert.ok(maxActive <= 3, `expected at most 3 concurrent, saw ${maxActive}`);
  assert.ok(maxActive >= 2, `expected real parallelism, saw ${maxActive}`);
});

test("skips candidates with a blank x_user_id or handle without calling recoverOne", async () => {
  let calls = 0;
  const recoverOne = async (): Promise<AvatarRecoveryOutcome> => {
    calls += 1;
    return { status: "stored" };
  };
  const stats = await runAvatarRecovery({
    candidates: [{ x_user_id: "   ", handle: "x" }, { x_user_id: "1", handle: "  " }, candidate("2")],
    recoverOne,
    logger: silentLogger,
    sleep: noSleep,
  });
  assert.equal(calls, 1);
  assert.equal(stats.skipped, 2);
  assert.equal(stats.stored, 1);
});

test("applies a per-item delay between processed candidates", async () => {
  const sleeps: number[] = [];
  const recoverOne = async (): Promise<AvatarRecoveryOutcome> => ({ status: "stored" });
  await runAvatarRecovery({
    candidates: [candidate("1"), candidate("2")],
    recoverOne,
    concurrency: 1,
    perItemDelayMs: 800,
    logger: silentLogger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [800, 800]);
});
