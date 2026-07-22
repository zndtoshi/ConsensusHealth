import test from "node:test";
import assert from "node:assert/strict";
import { FOLLOWER_FILTER_THRESHOLD } from "../config/followerFilters.js";
import {
  appendStanceCountsToAria,
  buildShareableFilterBadge,
  countVisibleStances,
  hasShareableVisibilityFilter,
  resolveClusterLabelOverlaps,
  worldToScreen,
} from "./shareableFilterContext.js";

test("no badge when no supported filter is active", () => {
  const badge = buildShareableFilterBadge(
    {
      plebsMode: false,
      influencersMode: false,
      joinDateFilterEnabled: false,
      joinDateMinYear: null,
      joinDateMaxYear: null,
    },
    500
  );
  assert.equal(badge.visible, false);
  assert.equal(hasShareableVisibilityFilter({
    plebsMode: false,
    influencersMode: false,
    joinDateFilterEnabled: false,
    joinDateMinYear: null,
    joinDateMaxYear: null,
  }), false);
});

test("join-date badge content", () => {
  const badge = buildShareableFilterBadge(
    {
      plebsMode: false,
      influencersMode: false,
      joinDateFilterEnabled: true,
      joinDateMinYear: 2006,
      joinDateMaxYear: 2019,
    },
    437
  );
  assert.equal(badge.visible, true);
  assert.equal(badge.primaryLine, "X joined");
  assert.equal(badge.secondaryLine, "2006–2019");
  assert.equal(badge.totalLine, "437 accounts");
});

test("Plebs badge content", () => {
  const badge = buildShareableFilterBadge(
    {
      plebsMode: true,
      influencersMode: false,
      joinDateFilterEnabled: false,
      joinDateMinYear: null,
      joinDateMaxYear: null,
    },
    312
  );
  assert.equal(badge.primaryLine, "Plebs");
  assert.equal(badge.secondaryLine, `Under ${Math.round(FOLLOWER_FILTER_THRESHOLD / 1000)}K followers`);
  assert.equal(badge.totalLine, "312 accounts");
});

test("Influencers badge content", () => {
  const badge = buildShareableFilterBadge(
    {
      plebsMode: false,
      influencersMode: true,
      joinDateFilterEnabled: false,
      joinDateMinYear: null,
      joinDateMaxYear: null,
    },
    125
  );
  assert.equal(badge.primaryLine, "Influencers");
  assert.equal(badge.secondaryLine, `Over ${Math.round(FOLLOWER_FILTER_THRESHOLD / 1000)}K followers`);
});

test("combined join-date + Plebs content", () => {
  const badge = buildShareableFilterBadge(
    {
      plebsMode: true,
      influencersMode: false,
      joinDateFilterEnabled: true,
      joinDateMinYear: 2006,
      joinDateMaxYear: 2019,
    },
    284
  );
  assert.equal(badge.primaryLine, "Plebs · X joined 2006–2019");
  assert.equal(badge.secondaryLine, null);
  assert.equal(badge.totalLine, "284 accounts");
});

test("combined join-date + Influencers content", () => {
  const badge = buildShareableFilterBadge(
    {
      plebsMode: false,
      influencersMode: true,
      joinDateFilterEnabled: true,
      joinDateMinYear: 2015,
      joinDateMaxYear: 2026,
    },
    97
  );
  assert.equal(badge.primaryLine, "Influencers · X joined 2015–2026");
});

test("both follower filters omit contradictory wording", () => {
  const badge = buildShareableFilterBadge(
    {
      plebsMode: true,
      influencersMode: true,
      joinDateFilterEnabled: true,
      joinDateMinYear: 2010,
      joinDateMaxYear: 2020,
    },
    50
  );
  assert.equal(badge.primaryLine, "X joined");
  assert.equal(badge.secondaryLine, "2010–2020");
  assert.doesNotMatch(badge.primaryLine, /Plebs.*Influencers|Influencers.*Plebs/);
});

test("stance counts match final filtered accounts", () => {
  const accounts = [
    { stance: "against" },
    { stance: "against" },
    { stance: "neutral" },
    { stance: "approve" },
  ];
  const { counts, total } = countVisibleStances(accounts, (a) => {
    const s = a.stance;
    if (s === "against" || s === "neutral" || s === "approve") return s;
    return null;
  });
  assert.equal(total, 4);
  assert.equal(counts.against, 2);
  assert.equal(counts.neutral, 1);
  assert.equal(counts.approve, 1);
});

test("zero-account clusters stay at zero", () => {
  const { counts } = countVisibleStances([{ stance: "against" }], (a) =>
    a.stance === "against" ? "against" : null
  );
  assert.equal(counts.neutral, 0);
  assert.equal(counts.approve, 0);
});

test("appendStanceCountsToAria builds accessible summary", () => {
  const text = appendStanceCountsToAria("Filtered graph: 10 accounts shown.", {
    against: 7,
    neutral: 1,
    approve: 2,
  });
  assert.match(text, /7 against, 1 neutral, 2 approve/);
});

test("resolveClusterLabelOverlaps pushes colliding labels down", () => {
  const resolved = resolveClusterLabelOverlaps(
    [
      { stance: "against", x: 10, y: 40, visible: true },
      { stance: "neutral", x: 50, y: 45, visible: true },
      { stance: "approve", x: 90, y: 200, visible: true },
    ],
    28
  );
  const neutral = resolved.find((p) => p.stance === "neutral")!;
  const against = resolved.find((p) => p.stance === "against")!;
  assert.ok(neutral.y - against.y >= 28);
});

test("worldToScreen applies view transform without mutating layout inputs", () => {
  const world = { x: 100, y: 50 };
  const screen = worldToScreen(world.x, world.y, { scale: 2, tx: 10, ty: 5 });
  assert.deepEqual(screen, { x: 210, y: 105 });
  assert.equal(world.x, 100);
});

test("FOLLOWER_FILTER_THRESHOLD matches product filter", () => {
  assert.equal(FOLLOWER_FILTER_THRESHOLD, 3000);
});
