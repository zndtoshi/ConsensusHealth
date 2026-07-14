import test from "node:test";
import assert from "node:assert/strict";
import { STANCE_COLORS, finalStanceColor } from "../../src/utils/stanceColors.ts";

test("final Approve word uses the approve/green color", () => {
  assert.equal(finalStanceColor("approve"), STANCE_COLORS.approve);
  assert.equal(STANCE_COLORS.approve, "#22c55e");
});

test("final Against word uses the against/red color", () => {
  assert.equal(finalStanceColor("against"), STANCE_COLORS.against);
  assert.equal(STANCE_COLORS.against, "#ef4444");
});

test("final Neutral stays normal white text (inherit)", () => {
  assert.equal(finalStanceColor("neutral"), "inherit");
});

test("unset or unknown final stance stays normal white text (inherit)", () => {
  assert.equal(finalStanceColor(null), "inherit");
  assert.equal(finalStanceColor(undefined), "inherit");
});
