import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROPOSAL_ID,
  listEnabledProposals,
  parseProposalFromPathname,
  resolveProposalId,
} from "./proposals.js";
import {
  normalizeIncomingProposalId,
  getAdjacent,
} from "../utils/proposalNavigation.js";

test("frontend resolveProposalId matches bip numbers", () => {
  assert.equal(resolveProposalId("54"), "bip54");
  assert.equal(resolveProposalId("bip119"), "bip119");
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

test("three enabled proposals exist", () => {
  assert.equal(listEnabledProposals().length, 3);
});

test("adjacent proposals wrap around", () => {
  const { prev, next, current } = getAdjacent("bip110");
  assert.equal(current.id, "bip110");
  assert.equal(prev.id, "bip119");
  assert.equal(next.id, "bip54");
});
