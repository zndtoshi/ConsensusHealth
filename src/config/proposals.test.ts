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
  resolveProposalId,
  adjacentProposals,
} from "./proposals.js";
import { normalizeIncomingProposalId } from "../utils/proposalNavigation.js";
import { resolveThemeKey, getTheme } from "./proposalThemes.js";

test("frontend resolveProposalId matches bip numbers", () => {
  assert.equal(resolveProposalId("54"), "bip54");
  assert.equal(resolveProposalId("bip448"), "bip448");
  assert.equal(resolveProposalId("xyz"), DEFAULT_PROPOSAL_ID);
});

test("parseProposalFromPathname reads /bip/:n", () => {
  assert.equal(parseProposalFromPathname("/bip/110"), "bip110");
  assert.equal(parseProposalFromPathname("/bip/54"), "bip54");
  assert.equal(parseProposalFromPathname("/"), DEFAULT_PROPOSAL_ID);
});

test("non-admin is forced to bip110", () => {
  assert.equal(normalizeIncomingProposalId("bip54", false), "bip110");
  assert.equal(normalizeIncomingProposalId("bip54", true), "bip54");
});

test("catalog order drives adjacency wrap", () => {
  const { prev, next, current } = adjacentProposals("bip110", FALLBACK_PROPOSALS);
  assert.equal(current.id, "bip110");
  assert.equal(prev.id, "bip448");
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
  assert.equal(normalizeIncomingProposalId("bip54", false, FALLBACK_PROPOSALS), "bip110");
});

test("distant galaxies are every accessible non-active proposal", () => {
  const active = "bip54";
  const distant = FALLBACK_PROPOSALS.filter((p) => p.enabled && p.id !== active).map((p) => p.id);
  assert.deepEqual(distant, ["bip110", "bip448"]);
});

test("proposal subtitles explain what each galaxy covers", () => {
  assert.equal(FALLBACK_PROPOSALS.find((p) => p.id === "bip110")?.description, "Reduced Data Temporary Softfork");
  assert.match(FALLBACK_PROPOSALS.find((p) => p.id === "bip54")?.description || "", /Consensus Cleanup/);
  assert.match(FALLBACK_PROPOSALS.find((p) => p.id === "bip448")?.description || "", /rebindable transactions/i);
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
