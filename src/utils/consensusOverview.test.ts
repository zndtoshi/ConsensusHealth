import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_PROPOSALS } from "../config/proposals.js";
import { STANCE_COLORS } from "./stanceColors.js";
import {
  isOverviewPath,
  buildStanceStarKeys,
  listOverviewCompletedProposals,
  listOverviewOngoingProposals,
  mapOverviewPayloadToStats,
  overviewHeading,
  readMeProposalStance,
  resolveOverviewPersonalStance,
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

test("resolveOverviewPersonalStance maps distinct me.proposal_stances per proposal", () => {
  const stances = {
    bip54: "approve",
    bip448: "against",
    bip460: "support",
    bip110: "neutral",
  };
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: false,
      rawStance: readMeProposalStance(stances, "bip54"),
    }).text,
    "Your stance: Approve"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: false,
      rawStance: readMeProposalStance(stances, "bip448"),
    }).text,
    "Your stance: Against"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: false,
      rawStance: readMeProposalStance(stances, "bip460"),
    }).stance,
    "approve"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: true,
      rawStance: readMeProposalStance(stances, "bip110"),
    }).text,
    "Your stance: Neutral"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: false,
      rawStance: readMeProposalStance(stances, "bip54"),
    }).valueColor,
    STANCE_COLORS.approve
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: false,
      rawStance: readMeProposalStance(stances, "bip448"),
    }).valueColor,
    STANCE_COLORS.against
  );
});

test("resolveOverviewPersonalStance empty and malformed wording", () => {
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: false,
      rawStance: null,
    }).text,
    "Your stance: Not chosen"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: true,
      rawStance: null,
    }).text,
    "Your stance: No recorded stance"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: false,
      rawStance: "maybe",
    }).kind,
    "not_chosen"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: true,
      completed: true,
      rawStance: "lol",
    }).kind,
    "no_recorded"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: false,
      completed: false,
      rawStance: "approve",
    }).kind,
    "hidden"
  );
  assert.equal(
    resolveOverviewPersonalStance({
      authenticated: false,
      completed: false,
      rawStance: "approve",
    }).text,
    null
  );
});

test("personal stance rows do not change public aggregate helpers", () => {
  const cards = [
    {
      proposalId: "bip54",
      totalUsersWithStance: 10,
      counts: { against: 1, neutral: 2, approve: 7 },
      status: "ok",
    },
  ];
  const before = sumStanceSelections(cards);
  resolveOverviewPersonalStance({
    authenticated: true,
    completed: false,
    rawStance: "against",
  });
  assert.equal(sumStanceSelections(cards), before);
  assert.equal(cards[0].counts.approve, 7);
});

test("App wires overview personal stances from me and hides toolbar stance on overview", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /showOverview/);
  assert.match(appSrc, /readShowOverviewFromLocation/);
  assert.match(appSrc, /ConsensusOverview/);
  assert.match(appSrc, /goToOverview/);
  assert.match(appSrc, /writeOverviewToLocation/);
  assert.match(appSrc, /if \(showOverview\) return;/);
  assert.match(appSrc, /stanceChoiceOpen && canManageOwnExplanation && !showOverview/);
  assert.match(appSrc, /onOverview=\{goToOverview\}/);
  assert.match(appSrc, /proposalStances=\{me\?\.authenticated === true \? me\?\.proposal_stances/);
  assert.match(appSrc, /authenticated=\{me\?\.authenticated === true\}/);
  // Toolbar stance / choose-position hidden on overview; Options + avatar remain.
  assert.match(appSrc, /\{!showOverview \? \(/);
  assert.match(appSrc, /Choose position/);
  assert.match(appSrc, /canChooseOwnStance/);
  assert.match(appSrc, /stanceSeg--solo/);
  // Galaxy path still uses canChooseOwnStance (not overview-only wipe).
  assert.match(
    appSrc,
    /canChooseOwnStance =\s*\n?\s*!showOverview &&\s*\n?\s*!showNameTheFork &&\s*\n?\s*me\?\.authenticated === true/
  );
  // Overview branch wraps toolbar stance; avatar menu still mounts for authenticated users.
  const overviewHide = appSrc.indexOf("{!showOverview ? (");
  const choosePos = appSrc.indexOf("Choose position");
  const avatarMenu = appSrc.indexOf("Account menu for");
  assert.ok(overviewHide >= 0 && choosePos > overviewHide, "Choose position stays inside !showOverview guard");
  assert.ok(avatarMenu > choosePos, "account avatar remains after stance toolbar");
});

test("ConsensusOverview UI distinguishes unique participants from stance selections", () => {
  const src = fs.readFileSync(path.join(here, "..", "components", "ConsensusOverview.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");
  assert.match(src, /unique participants/);
  assert.match(src, /stance selections/);
  assert.match(src, /Enter galaxy/);
  assert.match(src, /Completed proposals/);
  assert.match(src, /accounts with a stance/);
  assert.match(src, /aria-label/);
  assert.match(src, /prefers-reduced-motion|reducedMotion/);
  assert.doesNotMatch(src, /followers_count/);
  assert.match(src, /resolveOverviewPersonalStance/);
  assert.match(src, /Your stance:/);
  assert.match(src, /consensusOverviewCard__yourStance/);
  assert.match(src, /proposalStances/);
  assert.match(src, /personal\.text/);
  // No nested stance button inside the card button.
  assert.doesNotMatch(src, /consensusOverviewCard[\s\S]*?<button[^>]*stance/i);
  assert.match(cssSrc, /\.consensusOverviewCard__yourStance/);
  assert.match(cssSrc, /overflow-wrap:\s*anywhere/);
  assert.match(cssSrc, /\.consensusOverviewCard__yourStance\.is-empty/);
});

test("overview hides proposal-specific footer and statistics controls", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  assert.match(appSrc, /!showOverview && !showNameTheFork \? <div style=\{styles\.footerNote\}/);
  assert.match(appSrc, /!showOverview && !showNameTheFork \? \(\s*<>\s*<button[^>]+onClick=\{openStatsModal\}/);
  assert.match(appSrc, /setShowStatsModal\(false\)/);
});
