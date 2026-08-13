import test from "node:test";
import assert from "node:assert/strict";
import {
  isPersistedStanceUnchanged,
  shouldAutoOpenStanceChoice,
  stanceChoiceMode,
  strictNormalizedStance,
  toolbarStanceMeta,
  userHasChosenStance,
} from "./stanceChoice.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(join(root, "App.jsx"), "utf8");

test("strictNormalizedStance keeps missing distinct from Neutral", () => {
  assert.equal(strictNormalizedStance(null), null);
  assert.equal(strictNormalizedStance(""), null);
  assert.equal(strictNormalizedStance("   "), null);
  assert.equal(strictNormalizedStance("neutral"), "neutral");
  assert.equal(strictNormalizedStance("against"), "against");
  assert.equal(strictNormalizedStance("support"), "approve");
  assert.equal(strictNormalizedStance("approve"), "approve");
});

test("first-ever Neutral is not unchanged and must POST", () => {
  assert.equal(isPersistedStanceUnchanged(null, "neutral"), false);
  assert.equal(isPersistedStanceUnchanged("", "neutral"), false);
  assert.equal(isPersistedStanceUnchanged(undefined, "neutral"), false);
  assert.equal(isPersistedStanceUnchanged(null, "against"), false);
  assert.equal(isPersistedStanceUnchanged(null, "approve"), false);
  assert.match(appSrc, /isPersistedStanceUnchanged\(meForActiveProposal\?\.stance,\s*uiStance\)/);
});

test("repeat-saving an already persisted Neutral is unchanged", () => {
  assert.equal(isPersistedStanceUnchanged("neutral", "neutral"), true);
  assert.equal(isPersistedStanceUnchanged("against", "against"), true);
  assert.equal(isPersistedStanceUnchanged("support", "approve"), true);
  assert.equal(isPersistedStanceUnchanged("against", "neutral"), false);
});

test("new authenticated user without stance auto-opens choice card", () => {
  assert.equal(shouldAutoOpenStanceChoice({ authenticated: true, stance: null }), true);
  assert.equal(stanceChoiceMode({ authenticated: true, stance: null }), "choose");
  assert.equal(userHasChosenStance({ authenticated: true, stance: null }), false);
  assert.equal(userHasChosenStance({ authenticated: true, stance: "" }), false);
});

test("user with stance does not auto-open and uses change mode", () => {
  assert.equal(shouldAutoOpenStanceChoice({ authenticated: true, stance: "against" }), false);
  assert.equal(shouldAutoOpenStanceChoice({ authenticated: true, stance: "neutral" }), false);
  assert.equal(stanceChoiceMode({ authenticated: true, stance: "against" }), "change");
  assert.equal(userHasChosenStance({ authenticated: true, stance: "support" }), true);
});

test("logged-out users never auto-open", () => {
  assert.equal(shouldAutoOpenStanceChoice(null), false);
  assert.equal(shouldAutoOpenStanceChoice({ authenticated: false }), false);
});

test("App auto-opens stance-less ongoing galaxies once per visit without draft leakage", () => {
  assert.match(appSrc, /shouldAutoOpenStanceChoice\(meForActiveProposal\)/);
  assert.match(appSrc, /stancePromptVisitRef/);
  assert.match(appSrc, /dismissed:\s*true/);
  assert.match(appSrc, /key=\{`stance-card:\$\{stanceChoiceSession\}:\$\{activeProposalId\}`\}/);
  assert.match(appSrc, /setStanceChoiceOpen\(false\)/);
  assert.match(appSrc, /canChooseOwnStance/);
  // Close-on-proposal-change clears drafts/errors before auto-open can remount.
  assert.match(appSrc, /setStanceChoiceError\(""\)/);
  assert.match(appSrc, /setStanceChoiceStatus\(""\)/);
});

test("toolbarStanceMeta maps UI stance to chip + API value", () => {
  assert.deepEqual(toolbarStanceMeta("against"), {
    label: "Against",
    className: "stanceSeg--red",
    api: "against",
  });
  assert.deepEqual(toolbarStanceMeta("approve"), {
    label: "Approve",
    className: "stanceSeg--green",
    api: "support",
  });
  assert.deepEqual(toolbarStanceMeta("neutral"), {
    label: "Neutral",
    className: "stanceSeg--gray",
    api: "neutral",
  });
  assert.equal(toolbarStanceMeta(""), null);
});
