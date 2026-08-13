import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInfoPagePath } from "../utils/infoPagePath";
import { resolvePublicContactEmail } from "../utils/publicContactEmail";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(root, "src", "components", "InfoPages.jsx"), "utf8");
const cssSrc = readFileSync(join(root, "src", "index.css"), "utf8");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
const statsSrc = readFileSync(join(root, "src", "components", "StatisticsModal.tsx"), "utf8");

test("parseInfoPagePath recognizes privacy, terms, how-it-works", () => {
  assert.equal(parseInfoPagePath("/privacy"), "privacy");
  assert.equal(parseInfoPagePath("/terms/"), "terms");
  assert.equal(parseInfoPagePath("/how-it-works"), "how-it-works");
  assert.equal(parseInfoPagePath("/bip/110"), null);
  assert.equal(parseInfoPagePath("/"), null);
  assert.equal(parseInfoPagePath("/privacy-policy"), null);
});

test("InfoPages covers privacy topics from the launch brief", () => {
  assert.match(src, /X \(OAuth\)|sign in with X/i);
  assert.match(src, /bio\s*\/\s*description|X bio/i);
  assert.match(src, /sessionDaysLabel|sessionTtlDays/);
  assert.match(src, /session/i);
  assert.match(src, /[Cc]urated/);
  assert.match(src, /self-reported/i);
  assert.match(src, /Render|Postgres|Cloudflare/i);
  assert.match(src, /[Bb]ackups/);
  assert.match(src, /backupDaysLabel|backupRetentionDays/);
  assert.doesNotMatch(src, /recomputed after deletion/i);
  assert.doesNotMatch(src, /that backup retention window/);
  assert.doesNotMatch(src, /set VITE_CONTACT_EMAIL/);
  assert.doesNotMatch(src, /about 30 days/i);
  assert.doesNotMatch(src, /anonymous counts remain/i);
});

test("resolvePublicContactEmail only accepts valid emails", () => {
  assert.equal(resolvePublicContactEmail("ops@example.com"), "ops@example.com");
  assert.equal(resolvePublicContactEmail("not-an-email"), "");
  assert.equal(resolvePublicContactEmail(""), "");
});

test("InfoPages covers terms and how-it-works topics", () => {
  assert.match(src, /impersonat/i);
  assert.match(src, /[Mm]oderation/);
  assert.match(src, /not official Bitcoin\s+consensus/i);
  assert.match(src, /Avatar size|follower/i);
  assert.match(src, /Distant galaxies|dropdown/i);
  assert.match(src, /Statistics/);
});

test("InfoPages uses glass overlay styling and Escape close; App wires history", () => {
  assert.match(src, /infoPagesOverlay/);
  assert.match(src, /Escape/);
  assert.match(src, /role="dialog"/);
  assert.match(cssSrc, /\.infoPagesPanel\s*\{/);
  assert.match(cssSrc, /backdrop-filter:\s*blur/);
  assert.match(appSrc, /parseInfoPagePath/);
  assert.match(appSrc, /openInfoPage/);
  assert.match(appSrc, /InfoPages/);
  assert.doesNotMatch(appSrc, /className="legalFooterLinks"/);
  assert.match(statsSrc, /legalFooterLinks statisticsModal__infoLinks/);
  assert.match(statsSrc, /onOpenInfoPage\("privacy"\)/);
  assert.match(statsSrc, /onOpenInfoPage\("terms"\)/);
  assert.match(statsSrc, /onOpenInfoPage\("how-it-works"\)/);
  assert.match(appSrc, /openInfoPage\("terms"\)/);
  assert.match(appSrc, /stanceSuspendedForInfoRef/);
});

test("privacy copy does not advertise hidden self-service account deletion", () => {
  assert.doesNotMatch(src, /delete your account/i);
  assert.doesNotMatch(src, /personal data from the account menu/i);
});
