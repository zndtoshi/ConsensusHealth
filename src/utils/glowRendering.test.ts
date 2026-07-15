import test from "node:test";
import assert from "node:assert/strict";
import {
  CHROMIUM_GLOW_BLUR_MULTIPLIER,
  CHROMIUM_GLOW_OPACITY_MULTIPLIER,
  parseDebugGlowParams,
  resolveGlowProfile,
  scaleRgbaAlpha,
} from "./glowRendering.js";

test("parseDebugGlowParams reads debugGlow query values", () => {
  assert.equal(parseDebugGlowParams("?debugGlow=default"), "default");
  assert.equal(parseDebugGlowParams("?debugGlow=sharp"), "sharp");
  assert.equal(parseDebugGlowParams(""), null);
});

test("resolveGlowProfile keeps Firefox unchanged", () => {
  const profile = resolveGlowProfile({ isFirefox: true, isChromium: false, debugGlow: "sharp" });
  assert.equal(profile.id, "firefox");
  assert.equal(profile.quality, 0.48);
  assert.equal(profile.blurMultiplier, 1);
  assert.equal(profile.nonEmphasizedPasses, 1);
});

test("resolveGlowProfile tightens Chromium by default", () => {
  const profile = resolveGlowProfile({ isFirefox: false, isChromium: true, debugGlow: null });
  assert.equal(profile.id, "chromium-sharp");
  assert.equal(profile.blurMultiplier, CHROMIUM_GLOW_BLUR_MULTIPLIER);
  assert.equal(profile.opacityMultiplier, CHROMIUM_GLOW_OPACITY_MULTIPLIER);
  assert.equal(profile.nonEmphasizedPasses, 1);
});

test("resolveGlowProfile debugGlow=default restores legacy Chromium passes", () => {
  const profile = resolveGlowProfile({ isFirefox: false, isChromium: true, debugGlow: "default" });
  assert.equal(profile.id, "chromium-default");
  assert.equal(profile.blurMultiplier, 1);
  assert.equal(profile.nonEmphasizedPasses, 3);
});

test("scaleRgbaAlpha scales alpha channel", () => {
  assert.equal(scaleRgbaAlpha("rgba(220, 38, 38, 0.9)", 0.5), "rgba(220, 38, 38, 0.45)");
});
