import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
const sliderSrc = readFileSync(join(root, "src", "components", "XJoinDateRangeSlider.jsx"), "utf8");

test("X join date option appears after Influencers in Options menu markup", () => {
  const influencersIdx = appSrc.indexOf("Influencers (&gt;3k followers)");
  const joinIdx = appSrc.indexOf(">X join date<");
  assert.ok(influencersIdx > 0);
  assert.ok(joinIdx > influencersIdx);
});

test("slider is only rendered when join date filter is enabled", () => {
  assert.match(
    appSrc,
    /joinDateFilterEnabled && joinDateMinYear != null && joinDateMaxYear != null \? \(\s*<XJoinDateRangeSlider/
  );
});

test("dual-handle slider exposes accessible min/max labels", () => {
  assert.match(sliderSrc, /aria-label="Minimum X join year"/);
  assert.match(sliderSrc, /aria-label="Maximum X join year"/);
  assert.match(sliderSrc, /type="range"/);
});

test("empty-range message is defined for the graph area", () => {
  assert.match(appSrc, /No accounts joined X in this range\./);
});

test("join date filter does not trigger New Stances intro APIs", () => {
  // Enabling the filter only stops history playback; it must not call fetchNewStanceEvents.
  const enableFn = appSrc.slice(
    appSrc.indexOf("function enableJoinDateFilter"),
    appSrc.indexOf("function onJoinDateRangeChange")
  );
  assert.match(enableFn, /stopHistoryPlayback/);
  assert.doesNotMatch(enableFn, /fetchNewStanceEvents|beginNewStances|startNewStances/);
});

test("join date commit is separate from draft onChange", () => {
  assert.match(appSrc, /function onJoinDateRangeCommit/);
  assert.match(appSrc, /onCommit=\{onJoinDateRangeCommit\}/);
});
