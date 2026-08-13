import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isStanceOverlayPointerInterceptError,
  resolveStanceDialogOpenPlan,
} from "./stanceChoiceUi";

const helpersSrc = readFileSync(join(process.cwd(), "e2e", "helpers.ts"), "utf8");

test("auto-opened overlay/dialog plans wait instead of toolbar click", () => {
  assert.equal(
    resolveStanceDialogOpenPlan({ overlayPresent: true, dialogPresent: false }),
    "wait-for-dialog"
  );
  assert.equal(
    resolveStanceDialogOpenPlan({ overlayPresent: false, dialogPresent: true }),
    "wait-for-dialog"
  );
  assert.equal(
    resolveStanceDialogOpenPlan({ overlayPresent: true, dialogPresent: true }),
    "wait-for-dialog"
  );
});

test("absent overlay plans a toolbar click", () => {
  assert.equal(
    resolveStanceDialogOpenPlan({ overlayPresent: false, dialogPresent: false }),
    "click-toolbar"
  );
});

test("detects stance overlay pointer-intercept errors from the race window", () => {
  assert.equal(
    isStanceOverlayPointerInterceptError(
      new Error('<div class="stanceChoiceOverlay"/> intercepts pointer events')
    ),
    true
  );
  assert.equal(
    isStanceOverlayPointerInterceptError(
      new Error("locator.click: Element is not visible — stanceChoiceOverlay covering target")
    ),
    true
  );
  assert.equal(
    isStanceOverlayPointerInterceptError(new Error("locator.click: Timeout 3000ms exceeded")),
    false
  );
  assert.equal(isStanceOverlayPointerInterceptError(null), false);
});

test("E2E saveStanceViaUi uses race-safe dialog open helper", () => {
  assert.match(helpersSrc, /resolveStanceDialogOpenPlan/);
  assert.match(helpersSrc, /ensureStanceChoiceDialogOpen/);
  assert.match(helpersSrc, /isStanceOverlayPointerInterceptError/);
  assert.match(helpersSrc, /saveStanceViaUi[\s\S]*ensureStanceChoiceDialogOpen/);
  assert.doesNotMatch(
    helpersSrc,
    /async function saveStanceViaUi[\s\S]*openBtn\.click\(\)\s*;/
  );
});
