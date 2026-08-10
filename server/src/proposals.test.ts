import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PROPOSAL_ID,
  listEnabledProposals,
  resolveProposalId,
  tryResolveProposalId,
} from "./proposalCatalog.js";
import { resolveProposalAccess } from "./proposals.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("resolveProposalId accepts bip ids and numbers; invalid falls back to bip110", () => {
  assert.equal(resolveProposalId("bip110"), "bip110");
  assert.equal(resolveProposalId("110"), "bip110");
  assert.equal(resolveProposalId("BIP-54"), "bip54");
  assert.equal(resolveProposalId("448"), "bip448");
  assert.equal(resolveProposalId("nope"), DEFAULT_PROPOSAL_ID);
  assert.equal(resolveProposalId(""), DEFAULT_PROPOSAL_ID);
});

test("tryResolveProposalId returns null for unknown ids", () => {
  assert.equal(tryResolveProposalId("nope"), null);
  assert.equal(tryResolveProposalId("bip54"), "bip54");
});

test("enabled proposals include bip110/54/448 in display order", () => {
  const list = listEnabledProposals();
  assert.deepEqual(
    list.map((p) => p.id),
    ["bip110", "bip54", "bip448"]
  );
});

test("resolveProposalAccess allows bip110 for everyone; other BIPs admin-only", () => {
  assert.equal(resolveProposalAccess({ rawProposal: "bip110", sessionHandle: "alice" }).allowed, true);
  assert.equal(resolveProposalAccess({ rawProposal: "bip54", sessionHandle: "alice" }).allowed, false);
  assert.equal(resolveProposalAccess({ rawProposal: "bip54", sessionHandle: "zndtoshi" }).allowed, true);
  assert.equal(resolveProposalAccess({ rawProposal: "448", sessionHandle: "@ZndToshi" }).allowed, true);
  assert.equal(resolveProposalAccess({ rawProposal: "bip448", sessionHandle: null }).allowed, false);
});

test("ensureProposalSchema uses advisory lock and migration version", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "proposals.ts"), "utf8");
  const catalog = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "proposalCatalog.ts"),
    "utf8"
  );
  assert.match(src, /pg_advisory_xact_lock/);
  assert.match(src, /schema_migrations/);
  assert.match(catalog, /2026-07-consensus-universe-v1/);
  assert.match(src, /legacy_stance_history_id/);
  assert.match(src, /ON CONFLICT \(legacy_stance_history_id\) DO NOTHING/);
  assert.match(src, /ROLLBACK/);
});
