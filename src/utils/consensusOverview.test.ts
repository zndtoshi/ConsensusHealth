import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_PROPOSALS } from "../config/proposals.js";
import {
  isOverviewPath,
  buildStanceStarKeys,
  listOverviewCompletedProposals,
  listOverviewOngoingProposals,
  mapOverviewPayloadToStats,
  overviewHeading,
  sumStanceSelections,
} from "./consensusOverview.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("isOverviewPath recognizes only the root landing path", () => {
  assert.equal(isOverviewPath("/"), true);
  assert.equal(isOverviewPath(""), true);
  assert.equal(isOverviewPath("/?x=1"), true);
  assert.equal(isOverviewPath("/bip/54"), false);
  assert.equal(isOverviewPath("/bip/110"), false);
  assert.equal(isOverviewPath("/privacy"), false);
});

test("overview lists three ongoing cards and BIP110 completed from catalog status", () => {
  const ongoing = listOverviewOngoingProposals(FALLBACK_PROPOSALS);
  const completed = listOverviewCompletedProposals(FALLBACK_PROPOSALS);
  assert.deepEqual(
    ongoing.map((p) => p.id),
    ["bip54", "bip448", "bip460"]
  );
  assert.deepEqual(
    completed.map((p) => p.id),
    ["bip110"]
  );
  assert.ok(ongoing.every((p) => !p.adminOnly));
  assert.ok(completed.every((p) => !p.adminOnly));
});

test("overview heading and aggregate helpers stay honest", () => {
  assert.equal(overviewHeading(3), "ACTIVE CONSENSUS — 3 ongoing proposals");
  assert.equal(overviewHeading(1), "ACTIVE CONSENSUS — 1 ongoing proposal");
  assert.equal(
    sumStanceSelections([
      {
        proposalId: "bip54",
        totalUsersWithStance: 10,
        counts: { against: 1, neutral: 2, approve: 7 },
        status: "ok",
      },
      {
        proposalId: "bip448",
        totalUsersWithStance: 5,
        counts: { against: 0, neutral: 0, approve: 5 },
        status: "ok",
      },
    ]),
    15
  );
});

test("mapOverviewPayloadToStats uses stance rows not follower totals", () => {
  const mapped = mapOverviewPayloadToStats(
    {
      generated_at: new Date().toISOString(),
      ongoing_proposal_ids: ["bip54"],
      completed_proposal_ids: [],
      proposals: [
        {
          proposal_id: "bip54",
          total_users_with_stance: 4,
          against: 1,
          neutral: 1,
          approve: 2,
        },
      ],
      aggregates: { unique_participants: 3, stance_selections: 4 },
    },
    "bip54"
  );
  assert.equal(mapped.totalUsersWithStance, 4);
  assert.deepEqual(mapped.counts, { against: 1, neutral: 1, approve: 2 });
  assert.equal(mapped.status, "ok");
});

test("mini-galaxy stance samples never invent a zero-count stance", () => {
  assert.deepEqual(new Set(buildStanceStarKeys({ against: 0, neutral: 0, approve: 12 })), new Set(["approve"]));
  assert.deepEqual(new Set(buildStanceStarKeys({ against: 8, neutral: 0, approve: 0 })), new Set(["against"]));
  assert.deepEqual(buildStanceStarKeys({ against: 0, neutral: 0, approve: 0 }), []);
  const mixed = buildStanceStarKeys({ against: 1, neutral: 1, approve: 1 }, 18);
  assert.equal(mixed.length, 18);
  assert.deepEqual(new Set(mixed), new Set(["against", "neutral", "approve"]));
});

test("App wires overview as default landing without stance auto-open", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /showOverview/);
  assert.match(appSrc, /readShowOverviewFromLocation/);
  assert.match(appSrc, /ConsensusOverview/);
  assert.match(appSrc, /goToOverview/);
  assert.match(appSrc, /writeOverviewToLocation/);
  assert.match(appSrc, /if \(showOverview\) return;/);
  assert.match(appSrc, /stanceChoiceOpen && canManageOwnExplanation && !showOverview/);
  assert.match(appSrc, /onOverview=\{goToOverview\}/);
});

test("ConsensusOverview UI distinguishes unique participants from stance selections", () => {
  const src = fs.readFileSync(path.join(here, "..", "components", "ConsensusOverview.jsx"), "utf8");
  assert.match(src, /unique participants/);
  assert.match(src, /stance selections/);
  assert.match(src, /Enter galaxy/);
  assert.match(src, /Completed proposals/);
  assert.match(src, /accounts with a stance/);
  assert.match(src, /aria-label/);
  assert.match(src, /prefers-reduced-motion|reducedMotion/);
  assert.doesNotMatch(src, /followers_count/);
});

test("overview hides proposal-specific footer and statistics controls", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /!showOverview \? <div style=\{styles\.footerNote\}/);
  assert.match(appSrc, /!showOverview \? \(\s*<>\s*<button[^>]+onClick=\{openStatsModal\}/);
  assert.match(appSrc, /setShowStatsModal\(false\)/);
});
