import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeStanceExplanationUrl } from "../utils/stanceExplanationUrl";
import { snippetStanceExplanation } from "../utils/stanceExplanationSnippet";

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

test("App presents BIP-110 as a locked final snapshot with explanation management", () => {
  assert.doesNotMatch(appSrc, /archiveBanner/);
  assert.doesNotMatch(appSrc, /FINAL SNAPSHOT/);
  assert.match(appSrc, /meHasStance && meStanceToolbar/);
  assert.match(appSrc, /isFinalProposal\(activeProposal\)/);
  assert.match(appSrc, /StanceChoiceCard/);
  assert.match(appSrc, /canManageOwnExplanation/);
  assert.match(appSrc, /stanceFrozen/);
  assert.doesNotMatch(appSrc, /onClick=\{\(\) => setStanceChoiceOpen/);
});

test("BIP header has no hover info dialog; status is inline in the dropdown", () => {
  const headerSrc = readFileSync(join(root, "src", "components", "GalaxyHeaderNav.jsx"), "utf8");
  assert.doesNotMatch(headerSrc, /galaxyHeaderNav__tooltip/);
  assert.doesNotMatch(headerSrc, /role="tooltip"/);
  assert.doesNotMatch(headerSrc, /Concluded without consensus/);
  assert.doesNotMatch(headerSrc, /Ongoing proposal\. Current positions are self-reported/);
  assert.match(headerSrc, /FINAL SNAPSHOT/);
  assert.match(headerSrc, /ONGOING/);
  assert.match(headerSrc, /galaxyHeaderNav__optionStatus/);
  // Status sits inside the title row with the BIP name, not as a third line under the description.
  assert.match(
    headerSrc,
    /galaxyHeaderNav__optionTitle[\s\S]*?galaxyHeaderNav__optionStatus[\s\S]*?galaxyHeaderNav__optionDesc/
  );
  assert.doesNotMatch(
    headerSrc,
    /galaxyHeaderNav__optionDesc[\s\S]{0,160}galaxyHeaderNav__optionStatus/
  );
});

test("self-service stance writes are enabled for ongoing proposals; final stays frozen for everyone", () => {
  const userRoute = serverSrc.search(/app\.post\(\s*\n?\s*"\/api\/stance"/);
  const adminRoute = serverSrc.search(/app\.post\(\s*"\/api\/admin\/stance"/);
  assert.ok(userRoute >= 0);
  assert.ok(adminRoute >= 0);
  assert.match(serverSrc.slice(userRoute, userRoute + 1600), /proposal_stances_frozen|isFinalProposalStatus/);
  assert.match(serverSrc, /SELF_STANCE_UPDATES_ENABLED:\s*boolean\s*=\s*true/);
  assert.match(serverSrc, /createAdminStanceHandler/);
  assert.match(serverSrc, /isPrivilegedManualEditorHandle/);
  const adminHandlerSrc = readFileSync(join(root, "server", "src", "adminStanceHandlers.ts"), "utf8");
  assert.match(adminHandlerSrc, /isFinalProposalStatus/);
  assert.match(adminHandlerSrc, /proposal_stances_frozen/);
  assert.doesNotMatch(adminHandlerSrc, /editingSelf/);
  assert.match(appSrc, /Set user position/);
  assert.match(appSrc, /Edit positions on graph/);
  assert.match(appSrc, /\/api\/stance/);
  assert.match(appSrc, /saveOwnStanceChoice/);
});

test("stance card includes optional verified X explanation URL flow", () => {
  assert.match(cardSrc, /Explain your stance on X \(optional\)/);
  assert.match(
    cardSrc,
    /Optional\. Add a link to a post from your connected X account, or leave this blank and\s*save your stance\./
  );
  assert.match(cardSrc, /Change explanation/);
  assert.match(cardSrc, /Remove explanation/);
  assert.match(cardSrc, /onSave/);
  assert.match(cardSrc, /explanationAction[\s\S]*attach[\s\S]*none/);
  assert.match(appSrc, /\/api\/stance-explanation/);
  assert.match(appSrc, /wantsUrl/);
  assert.match(serverSrc, /app\.put\(\s*\n?\s*"\/api\/stance-explanation"/);
  assert.match(serverSrc, /app\.delete\(\s*\n?\s*"\/api\/stance-explanation"/);
});

test("stance card renders About section and full BIP GitHub link in both modes", () => {
  assert.match(cardSrc, /proposalAbout = null/);
  assert.match(cardSrc, /stanceChoiceCard__about/);
  assert.match(cardSrc, /stanceChoiceCard__scrollBody/);
  assert.match(cardSrc, /Read the full BIP on GitHub/);
  assert.match(
    cardSrc,
    /stanceChoiceCard__aboutHeading[\s\S]*?aboutHeading[\s\S]*?stanceChoiceCard__aboutStatusPill/
  );
  assert.doesNotMatch(cardSrc, /stanceChoiceCard__aboutStatus"/);
  assert.match(cardSrc, /proposalGithubUrl/);
  assert.match(cardSrc, /rel="noopener noreferrer"/);
  assert.match(cardSrc, /target="_blank"/);
  assert.match(cardSrc, /mode === "change"/);
  assert.match(appSrc, /proposalAbout=\{activeProposalAbout\}/);
  assert.match(appSrc, /proposalGithubUrl=\{activeProposalGithubUrl\}/);
  assert.match(appSrc, /buildProposalAbout\(activeProposal\)/);
  assert.match(cssSrc, /\.stanceChoiceCard__scrollBody\s*\{/);
  assert.match(cssSrc, /\.stanceChoiceCard__about\s*\{/);
  const proposalsSrc = readFileSync(join(root, "src", "config", "proposals.ts"), "utf8");
  assert.match(proposalsSrc, /bip54:[\s\S]*bip-0054/);
  assert.match(proposalsSrc, /bip110:[\s\S]*bip-0110/);
  assert.match(proposalsSrc, /bip448:[\s\S]*bip-0448/);
  assert.match(proposalsSrc, /bip460:[\s\S]*bip-XXXX|bip460:[\s\S]*fjahr/);
});

test("looksLikeStanceExplanationUrl accepts only basic status URLs", () => {
  assert.equal(looksLikeStanceExplanationUrl("https://x.com/alice/status/123"), true);
  assert.equal(looksLikeStanceExplanationUrl("https://t.co/abc"), false);
  assert.equal(looksLikeStanceExplanationUrl("https://x.com/i/web/status/1"), false);
});

test("hover and selected card render plain-text explanation surfaces", () => {
  assert.match(appSrc, /Stance explanation/);
  assert.match(appSrc, /snippetStanceExplanation/);
  assert.match(appSrc, /selectedUserCard__explanationText/);
  assert.match(appSrc, /View post on X/);
  assert.match(cssSrc, /selectedUserCard__explanationText/);
  assert.match(cssSrc, /min\(28vh,\s*220px\)/);
  assert.equal(snippetStanceExplanation("short"), "short");
  assert.match(snippetStanceExplanation("x".repeat(200), 40), /…$/);
});

test("selected-user card keeps the compact left-aligned identity layout", () => {
  assert.match(cssSrc, /(?:^|\n)\.selectedUserCard\s*\{[^}]*display:\s*inline-flex/m);
  assert.doesNotMatch(cssSrc, /(?:^|\n)\.selectedUserCard\s*\{[^}]*flex-direction:\s*column/m);
  assert.match(cssSrc, /(?:^|\n)\.selectedUserCard--withExplanation\s*\{[^}]*align-items:\s*stretch/m);
  assert.match(cssSrc, /(?:^|\n)\.selectedUserCard__identity\s*\{[^}]*display:\s*inline-flex/m);
  assert.match(cssSrc, /(?:^|\n)\.selectedUserCard__avatar\s*\{[^}]*width:\s*34px[^}]*height:\s*34px/m);
});

test("own stance chooser is available on ongoing proposals; final can manage explanations", () => {
  assert.match(appSrc, /canChooseOwnStance =\s*\n?\s*!showOverview && me\?\.authenticated === true && isOngoingProposal\(activeProposal\)/);
  assert.match(appSrc, /canManageOwnExplanation/);
  assert.match(appSrc, /openOwnStanceChoice/);
  assert.match(appSrc, /Choose your position/);
  assert.match(appSrc, /allowAbsentFromGalaxy/);
});
