import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cardSrc = readFileSync(join(root, "src", "components", "StanceChoiceCard.jsx"), "utf8");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
const cssSrc = readFileSync(join(root, "src", "index.css"), "utf8");
const serverSrc = readFileSync(join(root, "server", "src", "index.ts"), "utf8");

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

test("App presents BIP-110 as a locked final snapshot", () => {
  assert.match(appSrc, /BIP-110 has concluded/);
  assert.match(appSrc, /FINAL SNAPSHOT/);
  assert.match(appSrc, /meHasStance && meStanceToolbar/);
  assert.match(appSrc, /Your final BIP-110 position/);
  assert.doesNotMatch(appSrc, /onClick=\{\(\) => setStanceChoiceOpen/);
});

test("both user and admin BIP-110 stance writes are frozen server-side", () => {
  const userRoute = serverSrc.indexOf('app.post("/api/stance"');
  const adminRoute = serverSrc.indexOf('app.post("/api/admin/stance"');
  assert.ok(userRoute >= 0);
  assert.ok(adminRoute >= 0);
  assert.match(serverSrc.slice(userRoute, userRoute + 400), /status\(409\)/);
  assert.match(serverSrc.slice(adminRoute, adminRoute + 400), /status\(409\)/);
  assert.match(serverSrc, /bip110_stances_frozen/g);
});
