import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldAutoOpenStanceChoice,
  stanceChoiceMode,
  toolbarStanceMeta,
  userHasChosenStance,
} from "./stanceChoice.js";

test("new authenticated user without stance auto-opens choice card", () => {
  assert.equal(shouldAutoOpenStanceChoice({ authenticated: true, stance: null }), true);
  assert.equal(stanceChoiceMode({ authenticated: true, stance: null }), "choose");
  assert.equal(userHasChosenStance({ authenticated: true, stance: null }), false);
});

test("user with stance does not auto-open and uses change mode", () => {
  assert.equal(shouldAutoOpenStanceChoice({ authenticated: true, stance: "against" }), false);
  assert.equal(stanceChoiceMode({ authenticated: true, stance: "against" }), "change");
  assert.equal(userHasChosenStance({ authenticated: true, stance: "support" }), true);
});

test("logged-out users never auto-open", () => {
  assert.equal(shouldAutoOpenStanceChoice(null), false);
  assert.equal(shouldAutoOpenStanceChoice({ authenticated: false }), false);
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
