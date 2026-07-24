import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROPOSAL_ID,
  listEnabledProposals,
  resolveProposalId,
} from "./proposalCatalog.js";
import { resolveProposalAccess } from "./proposals.js";

test("resolveProposalId accepts bip ids and numbers; invalid falls back to bip110", () => {
  assert.equal(resolveProposalId("bip110"), "bip110");
  assert.equal(resolveProposalId("110"), "bip110");
  assert.equal(resolveProposalId("BIP-54"), "bip54");
  assert.equal(resolveProposalId("119"), "bip119");
  assert.equal(resolveProposalId("nope"), DEFAULT_PROPOSAL_ID);
  assert.equal(resolveProposalId(""), DEFAULT_PROPOSAL_ID);
});

test("enabled proposals include bip110/54/119 in display order", () => {
  const list = listEnabledProposals();
  assert.deepEqual(
    list.map((p) => p.id),
    ["bip110", "bip54", "bip119"]
  );
});

test("resolveProposalAccess allows bip110 for everyone; other BIPs admin-only", () => {
  assert.equal(resolveProposalAccess({ rawProposal: "bip110", sessionHandle: "alice" }).allowed, true);
  assert.equal(resolveProposalAccess({ rawProposal: "bip54", sessionHandle: "alice" }).allowed, false);
  assert.equal(resolveProposalAccess({ rawProposal: "bip54", sessionHandle: "zndtoshi" }).allowed, true);
  assert.equal(resolveProposalAccess({ rawProposal: "119", sessionHandle: "@ZndToshi" }).allowed, true);
  assert.equal(resolveProposalAccess({ rawProposal: "bip119", sessionHandle: null }).allowed, false);
});

test("ensureProposalSchema SQL is idempotent in intent (ON CONFLICT / IF NOT EXISTS)", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./proposals.ts", import.meta.url), "utf8")
  );
  assert.match(src, /CREATE TABLE IF NOT EXISTS proposals/);
  assert.match(src, /CREATE TABLE IF NOT EXISTS user_proposal_stances/);
  assert.match(src, /CREATE TABLE IF NOT EXISTS user_proposal_stance_history/);
  assert.match(src, /ON CONFLICT \(x_user_id, proposal_id\) DO NOTHING/);
  assert.match(src, /proposal_id = 'bip110'/);
});
