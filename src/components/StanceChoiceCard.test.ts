import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cardSrc = readFileSync(join(root, "src", "components", "StanceChoiceCard.jsx"), "utf8");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
const cssSrc = readFileSync(join(root, "src", "index.css"), "utf8");

test("stance choice card buttons use STANCE_COLORS for text", () => {
  assert.match(cardSrc, /style=\{\{ color: STANCE_COLORS\[choice\.ui\] \}\}/);
  assert.match(cardSrc, /Against|STANCE_LABELS/);
});

test("card visual tone reuses new-stances-like glass panel classes", () => {
  assert.match(cssSrc, /\.stanceChoiceCard\s*\{/);
  assert.match(cssSrc, /backdrop-filter:\s*blur\(34px\)/);
  assert.match(cssSrc, /rgba\(239,\s*68,\s*68/);
  assert.match(cssSrc, /rgba\(34,\s*197,\s*94/);
});

test("App opens stance card for new users and shows single toolbar stance after choice", () => {
  assert.match(appSrc, /shouldAutoOpenStanceChoice/);
  assert.match(appSrc, /StanceChoiceCard/);
  assert.match(appSrc, /meHasStance && meStanceToolbar/);
  assert.match(appSrc, /Your stance: \$\{meStanceToolbar\.label\}\. Click to change\./);
  assert.doesNotMatch(
    appSrc.slice(appSrc.indexOf("meHasStance && meStanceToolbar"), appSrc.indexOf("profileMenuRef")),
    /aria-label="Set your stance"/
  );
});
