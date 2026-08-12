import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROPOSAL_ID,
  FALLBACK_PROPOSALS,
  mapApiProposal,
  parseProposalFromPathname,
  proposalGithubUrl,
  resolveProposalId,
  adjacentProposals,
  selectDistantProposals,
  statisticsActionLabel,
  statisticsModalCopy,
} from "./proposals.js";
import { normalizeIncomingProposalId } from "../utils/proposalNavigation.js";
import { resolveThemeKey, getTheme } from "./proposalThemes.js";

test("frontend resolveProposalId matches bip numbers", () => {
  assert.equal(resolveProposalId("54"), "bip54");
  assert.equal(resolveProposalId("bip448"), "bip448");
  assert.equal(resolveProposalId("460"), "bip460");
  assert.equal(resolveProposalId("BIP-460"), "bip460");
  assert.equal(resolveProposalId("xyz"), DEFAULT_PROPOSAL_ID);
});

test("parseProposalFromPathname reads /bip/:n", () => {
  assert.equal(parseProposalFromPathname("/bip/110"), "bip110");
  assert.equal(parseProposalFromPathname("/bip/54"), "bip54");
  assert.equal(parseProposalFromPathname("/bip/460"), "bip460");
  assert.equal(parseProposalFromPathname("/"), DEFAULT_PROPOSAL_ID);
});

test("non-admin can open public ongoing proposals from the accessible catalog", () => {
  assert.equal(normalizeIncomingProposalId("bip54", false, FALLBACK_PROPOSALS), "bip54");
  assert.equal(normalizeIncomingProposalId("bip54", true, FALLBACK_PROPOSALS), "bip54");
  assert.equal(normalizeIncomingProposalId("bip460", false, FALLBACK_PROPOSALS), "bip460");
  assert.equal(normalizeIncomingProposalId("bip460", true, FALLBACK_PROPOSALS), "bip460");
});

test("catalog order drives adjacency wrap", () => {
  const { prev, next, current } = adjacentProposals("bip110", FALLBACK_PROPOSALS);
  assert.equal(current.id, "bip110");
  assert.equal(prev.id, "bip460");
  assert.equal(next.id, "bip54");
});

test("mapApiProposal uses validated theme_key only", () => {
  const mapped = mapApiProposal({
    id: "bip54",
    bip_number: 54,
    short_name: "BIP54",
    title: "BIP-54",
    description: "x",
    order: 1,
    admin_only: true,
    theme_key: "not-a-real-theme",
    empty_message: "empty",
  });
  assert.equal(resolveThemeKey("not-a-real-theme"), "nebula-red");
  assert.equal(mapped.themeKey, "nebula-red");
  assert.equal(mapped.visualTheme.accent, getTheme("nebula-red").accent);
});

test("unknown theme_key falls back safely", () => {
  assert.equal(resolveThemeKey("javascript:alert(1)"), "nebula-red");
});

test("invalid URL proposal falls back to first accessible / default", () => {
  assert.equal(parseProposalFromPathname("/bip/999", FALLBACK_PROPOSALS), DEFAULT_PROPOSAL_ID);
  assert.equal(
    normalizeIncomingProposalId("bip999", true, FALLBACK_PROPOSALS),
    FALLBACK_PROPOSALS[0].id
  );
  assert.equal(normalizeIncomingProposalId("bip54", false, FALLBACK_PROPOSALS), "bip54");
});

test("distant galaxies are every accessible non-active proposal", () => {
  const active = "bip54";
  const distant = FALLBACK_PROPOSALS.filter((p) => p.enabled && p.id !== active).map((p) => p.id);
  assert.deepEqual(distant, ["bip110", "bip448", "bip460"]);
});

test("proposal subtitles explain what each galaxy covers", () => {
  assert.equal(FALLBACK_PROPOSALS.find((p) => p.id === "bip110")?.description, "Reduced Data Temporary Softfork");
  assert.match(FALLBACK_PROPOSALS.find((p) => p.id === "bip54")?.description || "", /Consensus Cleanup/);
  assert.match(FALLBACK_PROPOSALS.find((p) => p.id === "bip448")?.description || "", /covenant building blocks/i);
  assert.equal(
    FALLBACK_PROPOSALS.find((p) => p.id === "bip460")?.description,
    "Cross-Input Signature Aggregation"
  );
});

test("proposalGithubUrl maps known BIPs and rejects unknowns", () => {
  assert.match(proposalGithubUrl("bip110") || "", /bip-0110\.mediawiki/);
  assert.match(proposalGithubUrl("BIP54") || "", /bip-0054\.md/);
  assert.match(proposalGithubUrl("bip448") || "", /bip-0448\.md/);
  assert.equal(
    proposalGithubUrl("bip460"),
    "https://github.com/fjahr/bips/blob/cf0d4f2142cd0504b16e86739167b1f7ab9a3a06/bip-XXXX.mediawiki"
  );
  assert.equal(proposalGithubUrl("bip999"), null);
});

test("BIP-460 is present after BIP-448 in the fallback catalog", () => {
  const ids = FALLBACK_PROPOSALS.filter((p) => p.enabled).map((p) => p.id);
  assert.deepEqual(ids, ["bip110", "bip54", "bip448", "bip460"]);
  const bip460 = FALLBACK_PROPOSALS.find((p) => p.id === "bip460");
  assert.equal(bip460?.bipNumber, 460);
  assert.equal(bip460?.shortName, "BIP460");
  assert.equal(bip460?.title, "BIP-460");
  assert.equal(bip460?.adminOnly, false);
  assert.equal(bip460?.order, 3);
  assert.equal(bip460?.themeKey, "nebula-yellow");
  assert.equal(bip460?.status, "ongoing");
  assert.equal(FALLBACK_PROPOSALS.find((p) => p.id === "bip110")?.status, "final");
});

test("selectDistantProposals prefers neighbors and caps at 4", () => {
  const from110 = selectDistantProposals("bip110", FALLBACK_PROPOSALS, 4).map((p) => p.id);
  assert.deepEqual(from110, ["bip460", "bip54", "bip448"]);
  const from54 = selectDistantProposals("bip54", FALLBACK_PROPOSALS, 4).map((p) => p.id);
  assert.ok(from54.includes("bip110"));
  assert.ok(from54.includes("bip448"));
  assert.equal(from54.length, 3);
  assert.ok(!from54.includes("bip54"));
  assert.equal(selectDistantProposals("bip110", FALLBACK_PROPOSALS, 2).length, 2);
});

test("statistics labels and modal copy follow proposal status", () => {
  assert.equal(statisticsActionLabel(FALLBACK_PROPOSALS.find((p) => p.id === "bip110")), "Final Results");
  assert.equal(statisticsActionLabel(FALLBACK_PROPOSALS.find((p) => p.id === "bip54")), "Statistics");
  assert.equal(statisticsModalCopy(FALLBACK_PROPOSALS.find((p) => p.id === "bip110")).heading, "BIP-110 Final Results");
  assert.equal(statisticsModalCopy(FALLBACK_PROPOSALS.find((p) => p.id === "bip54")).heading, "BIP-54 Statistics");
  assert.match(statisticsModalCopy(FALLBACK_PROPOSALS.find((p) => p.id === "bip460")).subtitle, /ongoing/i);
});

test("nebula-yellow is a validated theme and BIP-460 uses its accents", () => {
  assert.equal(resolveThemeKey("nebula-yellow"), "nebula-yellow");
  const yellow = getTheme("nebula-yellow");
  assert.match(yellow.accent, /#e8d48b/i);
  assert.match(yellow.accentSoft, /232,\s*212,\s*139/);
  assert.match(yellow.distantGlow, /202,\s*168,\s*68/);
  assert.match(yellow.nebulaFrom, /133,\s*98,\s*18/);
  const bip460 = FALLBACK_PROPOSALS.find((p) => p.id === "bip460");
  assert.equal(bip460?.themeKey, "nebula-yellow");
  assert.equal(bip460?.visualTheme.accent, yellow.accent);
  assert.equal(bip460?.visualTheme.distantGlow, yellow.distantGlow);
  assert.equal(bip460?.visualTheme.nebulaFrom, yellow.nebulaFrom);
});

test("reduced-motion hook subscribes to matchMedia change events", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "usePrefersReducedMotion.js"),
    "utf8"
  );
  assert.match(src, /prefers-reduced-motion:\s*reduce/);
  assert.match(src, /addEventListener\("change"/);
  assert.match(src, /removeEventListener\("change"/);
});
