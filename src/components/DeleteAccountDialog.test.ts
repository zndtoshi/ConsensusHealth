import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(root, "src", "components", "DeleteAccountDialog.jsx"), "utf8");
const cssSrc = readFileSync(join(root, "src", "index.css"), "utf8");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");

test("DeleteAccountDialog requires handle confirmation and lists removals", () => {
  assert.match(src, /role="dialog"/);
  assert.match(src, /role="alert"/);
  assert.match(src, /confirmHandle/);
  assert.match(src, /onConfirm/);
  assert.match(src, /stances|history|explanations/i);
  assert.match(src, /preferences/i);
  assert.match(src, /avatar/i);
  assert.match(src, /recomputed after deletion/i);
  assert.match(src, /with or without @/i);
  assert.match(src, /returnFocusRef/);
  assert.match(src, /inert|aria-hidden/);
  assert.match(src, /Escape/);
  assert.match(src, /Tab/);
});

test("DeleteAccountDialog has glass destructive styling and mobile overflow", () => {
  assert.match(cssSrc, /\.deleteAccountDialog\s*\{/);
  assert.match(cssSrc, /\.deleteAccountDialog__confirm/);
  assert.match(cssSrc, /\.deleteAccountOverlay\s*\{[\s\S]*?overflow:\s*auto/);
});

test("App wires delete to POST /api/me/delete with confirm_handle and clears UI", () => {
  assert.match(appSrc, /DeleteAccountDialog/);
  assert.match(appSrc, /\/api\/me\/delete/);
  assert.match(appSrc, /confirm_handle/);
  assert.match(appSrc, /credentials:\s*["']include["']/);
  assert.match(appSrc, /setDataReloadToken/);
  assert.match(appSrc, /forceClearHoverUi|setHistoryPanel\(null\)/);
  assert.match(appSrc, /returnFocusRef=\{deleteAccountInvokerRef\}/);
});
