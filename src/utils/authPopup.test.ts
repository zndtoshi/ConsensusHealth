import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_MESSAGE_SOURCE,
  isAuthResultMessage,
  isAuthSuccessMessage,
  buildPopupFeatures,
} from "./authPopup";

test("accepts a valid success message", () => {
  const msg = { source: AUTH_MESSAGE_SOURCE, status: "success" };
  assert.equal(isAuthResultMessage(msg), true);
  assert.equal(isAuthSuccessMessage(msg), true);
});

test("accepts a valid error message but not as success", () => {
  const msg = { source: AUTH_MESSAGE_SOURCE, status: "error" };
  assert.equal(isAuthResultMessage(msg), true);
  assert.equal(isAuthSuccessMessage(msg), false);
});

test("rejects messages with the wrong source", () => {
  assert.equal(isAuthResultMessage({ source: "evil", status: "success" }), false);
  assert.equal(isAuthSuccessMessage({ source: "evil", status: "success" }), false);
});

test("rejects messages with an unknown status", () => {
  assert.equal(isAuthResultMessage({ source: AUTH_MESSAGE_SOURCE, status: "pending" }), false);
});

test("rejects non-object / nullish payloads", () => {
  assert.equal(isAuthResultMessage(null), false);
  assert.equal(isAuthResultMessage(undefined), false);
  assert.equal(isAuthResultMessage("success"), false);
  assert.equal(isAuthResultMessage(42), false);
});

test("buildPopupFeatures centers the popup using window geometry", () => {
  const fakeWin = { screenX: 100, screenY: 50, outerWidth: 1600, outerHeight: 1000 };
  const features = buildPopupFeatures(fakeWin);
  assert.ok(features.includes("width=600"));
  assert.ok(features.includes("height=720"));
  // left = 100 + (1600-600)/2 = 600 ; top = 50 + (1000-720)/2 = 190
  assert.ok(features.includes("left=600"));
  assert.ok(features.includes("top=190"));
});

test("buildPopupFeatures does not throw when geometry is missing", () => {
  assert.doesNotThrow(() => buildPopupFeatures({}));
  assert.ok(buildPopupFeatures({}).includes("width=600"));
});
