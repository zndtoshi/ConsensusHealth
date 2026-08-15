import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  friendlyNameTheForkError,
  isNameTheForkPath,
  NAME_THE_FORK_MAX_CHARS,
  NAME_THE_FORK_PATH,
  NAME_THE_FORK_THEME,
  normalizeCandidateName,
  graphemeLength,
} from "./nameTheFork.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("isNameTheForkPath recognizes only the hidden galaxy route", () => {
  assert.equal(isNameTheForkPath(NAME_THE_FORK_PATH), true);
  assert.equal(isNameTheForkPath("/name-the-fork/"), true);
  assert.equal(isNameTheForkPath("/"), false);
  assert.equal(isNameTheForkPath("/bip/54"), false);
});

test("client normalizeCandidateName mirrors server rules including Unicode graphemes", () => {
  assert.equal(normalizeCandidateName("Bdash").ok, true);
  assert.equal(normalizeCandidateName("a".repeat(NAME_THE_FORK_MAX_CHARS + 1)).ok, false);
  assert.equal(normalizeCandidateName("@x").ok, false);
  assert.equal(graphemeLength("👨‍💻"), 1);
  assert.match(friendlyNameTheForkError("custom_already_submitted"), /already suggested/i);
  assert.match(NAME_THE_FORK_THEME.accent, /#34d399/i);
});

test("App mounts discovery star in both canvas and stance-list BIP galaxies", () => {
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  const starSrc = fs.readFileSync(path.join(here, "..", "components", "HiddenGalaxyStar.jsx"), "utf8");
  const galaxySrc = fs.readFileSync(path.join(here, "..", "components", "NameTheForkGalaxy.jsx"), "utf8");
  const cssSrc = fs.readFileSync(path.join(here, "..", "index.css"), "utf8");

  assert.match(appSrc, /HiddenGalaxyStar/);
  assert.match(appSrc, /travelToNameTheFork/);
  assert.match(appSrc, /NameTheForkGalaxy/);
  assert.match(appSrc, /showNameTheFork/);
  assert.match(appSrc, /!showOverview &&\s*\n\s*!showNameTheFork/);
  // Shared overlay after the canvas/stance-list branch (not gated by canvas-only).
  const stanceBranch = appSrc.indexOf("!stanceListsViewEnabled ?");
  const starMount = appSrc.indexOf("<HiddenGalaxyStar");
  assert.ok(stanceBranch >= 0 && starMount > stanceBranch, "star must mount after layout branch");
  assert.doesNotMatch(appSrc, /!stanceListsViewEnabled\s*&&[\s\S]{0,120}<HiddenGalaxyStar/);
  assert.doesNotMatch(appSrc, /ch_ntf_pending/);
  assert.match(appSrc, /nameTheForkTravelTimerRef/);
  assert.match(appSrc, /prefersGalaxyReducedMotion[\s\S]*?finish\(\)/);

  assert.match(starSrc, /Discover a hidden galaxy/);
  assert.match(starSrc, /A distant signal/);
  assert.doesNotMatch(starSrc, /onKeyDown/);
  assert.match(starSrc, /type="button"/);

  assert.match(galaxySrc, /Return to consensus/);
  assert.match(galaxySrc, /Suggest a name/);
  assert.match(galaxySrc, /Remove vote/);
  assert.match(galaxySrc, /Vote recorded\./);
  assert.match(galaxySrc, /Vote changed\./);
  assert.match(galaxySrc, /Vote removed\./);
  assert.match(galaxySrc, /Custom name submitted\./);
  assert.match(galaxySrc, /Candidate hidden\./);
  assert.doesNotMatch(galaxySrc, /["']Saved\.["']/);
  assert.match(galaxySrc, /\+\{overflow\} more/);
  assert.match(galaxySrc, /LoadingSkeletons|nameTheFork__skeleton/);
  assert.match(galaxySrc, /AbortController/);
  assert.match(galaxySrc, /mountedRef/);
  assert.doesNotMatch(galaxySrc, /Against|Neutral|Approve/);
  assert.doesNotMatch(galaxySrc, /user_proposal_stances/);

  assert.match(cssSrc, /@media \(max-width: 860px\)[\s\S]*?\.nameTheFork \{[\s\S]*?overflow-y:\s*auto/);
  assert.match(cssSrc, /\.nameTheFork__header \{[\s\S]*?position:\s*sticky/);
});

test("Statistics modal keeps Escape disabled while Privacy/Terms cover it", () => {
  const statsSrc = fs.readFileSync(
    path.join(here, "..", "components", "StatisticsModal.tsx"),
    "utf8"
  );
  const appSrc = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");
  const infoSrc = fs.readFileSync(path.join(here, "..", "components", "InfoPages.jsx"), "utf8");
  assert.match(statsSrc, /escapeEnabled/);
  assert.match(statsSrc, /inertWhileCovered/);
  assert.match(appSrc, /escapeEnabled=\{!infoPagePath\}/);
  assert.match(appSrc, /inertWhileCovered=\{Boolean\(infoPagePath\)\}/);
  assert.match(appSrc, /infoPageReturnFocusRef/);
  assert.match(appSrc, /scheduleFocusRestore/);
  assert.doesNotMatch(
    appSrc,
    /onOpenInfoPage=\{\(page\) => \{\s*setShowStatsModal\(false\)/
  );
  assert.match(infoSrc, /stopPropagation/);
  // Parent owns return focus; InfoPages must not restore during inert cleanup.
  assert.doesNotMatch(infoSrc, /prev\.focus/);
});
