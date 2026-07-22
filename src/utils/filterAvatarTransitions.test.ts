import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JOIN_DATE_KEYBOARD_COMMIT_MS,
  accountStableKey,
  computeStanceClusterBounds,
  diffAccountKeySets,
  diffVisibleAccounts,
  easeOutCubic,
  enterStagingPosition,
  exitDriftDelta,
  filterTransitionAnnouncement,
  formatFilterTransitionDebug,
  hashUnit,
  isEnterHoverable,
  membershipSignatureFromKeys,
  parseDebugFilterTransitions,
  prefersFilterReducedMotion,
  sampleEnterMotion,
  sampleExitMotion,
  selectFilterTransitionTier,
  shouldCloseHoverForExitingKey,
  staggerDelayMs,
  transitionTotalDurationMs,
} from "./filterAvatarTransitions.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
const sliderSrc = readFileSync(join(root, "src", "components", "XJoinDateRangeSlider.jsx"), "utf8");

test("stable X ID string is preferred over handle for identity", () => {
  const a = { x_user_id: "1234567890123456789", handle: "Alice" };
  const b = { x_user_id: "1234567890123456789", handle: "alice_renamed" };
  assert.equal(accountStableKey(a), accountStableKey(b));
  assert.match(accountStableKey(a), /^xid:1234567890123456789$/);
});

test("handle fallback is used only when X ID is missing", () => {
  assert.equal(accountStableKey({ handle: "@Bob" }), "h:bob");
  assert.equal(accountStableKey({}), "");
});

test("diffVisibleAccounts uses keys not object identity", () => {
  const prev = [
    { x_user_id: "1", handle: "a" },
    { x_user_id: "2", handle: "b" },
  ];
  const next = [
    { x_user_id: "2", handle: "b" },
    { x_user_id: "3", handle: "c" },
  ];
  const d = diffVisibleAccounts(prev, next);
  assert.deepEqual(d.entering, ["xid:3"]);
  assert.deepEqual(d.exiting, ["xid:1"]);
  assert.deepEqual(d.retained, ["xid:2"]);
  assert.equal(d.changedCount, 2);
});

test("retained accounts are not treated as entering", () => {
  const d = diffAccountKeySets(["xid:1", "xid:2"], ["xid:1", "xid:2", "xid:3"]);
  assert.ok(!d.entering.includes("xid:1"));
  assert.ok(!d.entering.includes("xid:2"));
  assert.deepEqual(d.retained, ["xid:1", "xid:2"]);
});

test("Plebs/Influencers-style membership diffs produce correct enter/exit sets", () => {
  const all = [
    { x_user_id: "10", handle: "pleb" },
    { x_user_id: "20", handle: "influencer" },
    { x_user_id: "30", handle: "mid" },
  ];
  const plebs = [all[0], all[2]];
  const influencers = [all[1]];
  const toPlebs = diffVisibleAccounts(all, plebs);
  assert.deepEqual(toPlebs.exiting, ["xid:20"]);
  assert.deepEqual(toPlebs.entering, []);
  const offPlebs = diffVisibleAccounts(plebs, all);
  assert.deepEqual(offPlebs.entering, ["xid:20"]);
  const toInf = diffVisibleAccounts(all, influencers);
  assert.deepEqual(toInf.exiting.sort(), ["xid:10", "xid:30"]);
});

test("hashUnit is deterministic and exit drift has no Math.random", () => {
  assert.equal(hashUnit("xid:42"), hashUnit("xid:42"));
  assert.notEqual(hashUnit("xid:42"), hashUnit("xid:43"));
  const a = exitDriftDelta("against", "xid:1", 30);
  const b = exitDriftDelta("against", "xid:1", 30);
  assert.deepEqual(a, b);
  assert.ok(a.x < 0);
  const ap = exitDriftDelta("approve", "xid:1", 30);
  assert.ok(ap.x > 0);
  const n = exitDriftDelta("neutral", "xid:1", 30);
  assert.ok(n.y < 0);
});

test("enter staging is deterministic and stance-directed", () => {
  const bounds = {
    against: { minX: 100, maxX: 200, minY: 50, maxY: 150, cx: 150, cy: 100, count: 2 },
    approve: { minX: 400, maxX: 500, minY: 50, maxY: 150, cx: 450, cy: 100, count: 2 },
    neutral: { minX: 250, maxX: 350, minY: 40, maxY: 140, cx: 300, cy: 90, count: 2 },
  };
  const left = enterStagingPosition({
    stance: "against",
    key: "xid:1",
    targetX: 150,
    targetY: 100,
    bounds: bounds.against,
  });
  const right = enterStagingPosition({
    stance: "approve",
    key: "xid:2",
    targetX: 450,
    targetY: 100,
    bounds: bounds.approve,
  });
  const up = enterStagingPosition({
    stance: "neutral",
    key: "xid:3",
    targetX: 300,
    targetY: 90,
    bounds: bounds.neutral,
  });
  assert.ok(left.x < bounds.against.minX);
  assert.ok(right.x > bounds.approve.maxX);
  assert.ok(up.y < bounds.neutral.minY);
  assert.deepEqual(
    enterStagingPosition({
      stance: "against",
      key: "xid:1",
      targetX: 150,
      targetY: 100,
      bounds: bounds.against,
    }),
    left
  );
});

test("adaptive tiers: full / medium / large / reduced", () => {
  assert.equal(selectFilterTransitionTier(10, false).id, "full");
  assert.equal(selectFilterTransitionTier(40, false).id, "full");
  assert.equal(selectFilterTransitionTier(41, false).id, "medium");
  assert.equal(selectFilterTransitionTier(120, false).id, "medium");
  assert.equal(selectFilterTransitionTier(121, false).id, "large");
  const red = selectFilterTransitionTier(200, true);
  assert.equal(red.id, "reduced");
  assert.equal(red.driftPx, 0);
  assert.equal(red.staggerMs, 0);
});

test("large-batch total duration stays under ~900ms", () => {
  const large = selectFilterTransitionTier(200, false);
  const total = transitionTotalDurationMs(150, 80, large);
  assert.ok(total <= large.maxTotalMs);
  assert.ok(total <= 900);
});

test("reduced motion samples fade only (no flight)", () => {
  const exit = sampleExitMotion({
    elapsedMs: 75,
    delayMs: 0,
    durationMs: 150,
    startX: 10,
    startY: 20,
    driftX: 40,
    driftY: -40,
    endScale: 0.8,
    reducedMotion: true,
  });
  assert.equal(exit.x, 10);
  assert.equal(exit.y, 20);
  assert.equal(exit.scale, 1);
  assert.ok(exit.opacity < 1);

  const enter = sampleEnterMotion({
    elapsedMs: 75,
    delayMs: 0,
    durationMs: 150,
    startX: 0,
    startY: 0,
    targetX: 100,
    targetY: 100,
    startScale: 0.8,
    reducedMotion: true,
  });
  assert.equal(enter.x, 100);
  assert.equal(enter.y, 100);
  assert.equal(enter.scale, 1);
  assert.ok(enter.opacity > 0);
});

test("easeOutCubic and stagger helpers", () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.ok(easeOutCubic(0.5) > 0.5);
  const tier = selectFilterTransitionTier(10, false);
  assert.equal(staggerDelayMs(0, tier), 0);
  assert.ok(staggerDelayMs(1000, tier) <= tier.maxStaggerMs);
});

test("enter hoverable near completion; exit closes hover", () => {
  assert.equal(isEnterHoverable(0.5), false);
  assert.equal(isEnterHoverable(0.85), true);
  assert.equal(shouldCloseHoverForExitingKey("xid:1", ["xid:2"]), false);
  assert.equal(shouldCloseHoverForExitingKey("xid:1", ["xid:1"]), true);
});

test("cluster bounds and membership signature", () => {
  const bounds = computeStanceClusterBounds(
    [
      { x: 10, y: 20, half: 5 },
      { x: 30, y: 40, half: 5 },
    ],
    () => "against"
  );
  assert.equal(bounds.against.count, 2);
  assert.equal(bounds.against.minX, 5);
  assert.equal(membershipSignatureFromKeys(["b", "a"]), "a\nb");
});

test("debug param and announcement helpers", () => {
  assert.equal(parseDebugFilterTransitions("?debugFilterTransitions=1").enabled, true);
  assert.equal(parseDebugFilterTransitions("").enabled, false);
  assert.match(
    filterTransitionAnnouncement({ joinDateActive: true, visibleCount: 406 }),
    /X join-date filter applied\. 406 accounts visible\./
  );
  const line = formatFilterTransitionDebug({
    previousVisibleCount: 10,
    nextVisibleCount: 8,
    enteringCount: 1,
    exitingCount: 3,
    retainedCount: 7,
    tier: "full",
    transitionDurationMs: 500,
    animationFrames: 30,
    canceled: false,
    interrupted: true,
    finalSimulationNodeCount: 8,
    exitingRemoved: true,
  });
  assert.match(line, /interrupted=1/);
  assert.match(line, /exitingRemoved=1/);
});

test("prefersFilterReducedMotion reads matchMedia", () => {
  assert.equal(
    prefersFilterReducedMotion(() => ({ matches: true })),
    true
  );
  assert.equal(
    prefersFilterReducedMotion(() => ({ matches: false })),
    false
  );
});

test("slider commits on pointer/touch release and keyboard debounce; drag uses onChange only", () => {
  assert.match(sliderSrc, /onPointerUp|onMouseUp/);
  assert.match(sliderSrc, /onTouchEnd|touchend|onPointerUp/);
  assert.match(sliderSrc, /onCommit/);
  assert.match(sliderSrc, /JOIN_DATE_KEYBOARD_COMMIT_MS|commitTimerRef/);
  assert.match(sliderSrc, /from ["'].*filterAvatarTransitions["']/);
  assert.match(sliderSrc, /onChange\(/);
});

test("App separates draft join-date UI from committed filter membership", () => {
  assert.match(appSrc, /joinDateCommittedMin|CommittedMin/);
  assert.match(appSrc, /onJoinDateRangeCommit|onCommit=\{/);
  assert.match(appSrc, /filterAvatarTransitions|startFilterAvatarTransition|filterTransitionRef/);
});

test("App does not rebuild join-date graph from draft drag alone", () => {
  // visibleAccounts must use committed years, not draft slider years alone
  assert.match(appSrc, /joinDateCommittedMin/);
  assert.match(appSrc, /filterAccountsByJoinDate\([\s\S]*joinDateCommittedMin/);
});

test("filter transitions reuse avatar cache and scheduleDraw coalescing", () => {
  assert.match(appSrc, /getGraphAvatar|getAvatarPrioritized/);
  assert.match(appSrc, /scheduleDraw\(\)/);
  assert.match(appSrc, /filterTransitionRef/);
  assert.match(appSrc, /beginFilterMembershipTransition/);
  // Filter transition helper module must not touch New Stances storage markers.
  const utilSrc = readFileSync(join(root, "src", "utils", "filterAvatarTransitions.ts"), "utf8");
  assert.doesNotMatch(utilSrc, /writeLastSeenMarker|LAST_SEEN_MARKER|sessionStorage/);
  assert.doesNotMatch(utilSrc, /newStancesIntro/);
});

test("reduced motion and debugFilterTransitions wiring present", () => {
  assert.match(appSrc, /debugFilterTransitions|parseDebugFilterTransitions/);
  assert.match(appSrc, /prefersFilterReducedMotion|reducedMotion/);
  assert.match(appSrc, /isEnterHoverable/);
});

test("keyboard commit constant is short debounce", () => {
  assert.ok(JOIN_DATE_KEYBOARD_COMMIT_MS >= 120);
  assert.ok(JOIN_DATE_KEYBOARD_COMMIT_MS <= 250);
});
