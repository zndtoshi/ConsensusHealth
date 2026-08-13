import test from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_PROPOSALS, proposalGithubUrl } from "../config/proposals";
import { buildProposalAbout } from "./proposalAbout";

const IDS = ["bip54", "bip110", "bip448", "bip460"] as const;

test("buildProposalAbout covers all four BIPs with distinct descriptions and GitHub URLs", () => {
  const aboutById = new Map(
    IDS.map((id) => {
      const proposal = FALLBACK_PROPOSALS.find((p) => p.id === id);
      assert.ok(proposal, `missing fallback proposal ${id}`);
      const about = buildProposalAbout(proposal);
      assert.ok(about);
      return [id, about!] as const;
    })
  );

  for (const id of IDS) {
    const about = aboutById.get(id)!;
    assert.equal(about.id, id);
    assert.ok(about.description.length > 8, `${id} description`);
    assert.ok(about.title.toLowerCase().includes(id.replace("bip", "")), `${id} title`);
    assert.ok(about.statusLabel.length > 0);
    if (about.status !== "ongoing") assert.ok(about.statusDetail.length > 0);
    assert.equal(about.githubUrl, proposalGithubUrl(id));
    assert.ok(about.githubUrl, `${id} github`);
    assert.match(about.heading, /^About /);
  }

  // No cross-leakage of description or GitHub URL across proposals.
  const descriptions = IDS.map((id) => aboutById.get(id)!.description);
  const githubs = IDS.map((id) => aboutById.get(id)!.githubUrl);
  assert.equal(new Set(descriptions).size, 4);
  assert.equal(new Set(githubs).size, 4);

  assert.match(aboutById.get("bip54")!.description, /Consensus Cleanup/i);
  assert.match(aboutById.get("bip110")!.description, /Reduced Data/i);
  assert.match(aboutById.get("bip448")!.description, /Taproot|covenant|rebindable/i);
  assert.match(aboutById.get("bip460")!.description, /Signature Aggregation|aggregat/i);

  assert.match(String(aboutById.get("bip54")!.githubUrl), /bip-0054/);
  assert.match(String(aboutById.get("bip110")!.githubUrl), /bip-0110/);
  assert.match(String(aboutById.get("bip448")!.githubUrl), /bip-0448/);
  assert.match(String(aboutById.get("bip460")!.githubUrl), /fjahr|bip-XXXX/);
});

test("buildProposalAbout status labels match proposal status", () => {
  const finalAbout = buildProposalAbout(FALLBACK_PROPOSALS.find((p) => p.id === "bip110")!);
  assert.equal(finalAbout?.status, "final");
  assert.equal(finalAbout?.statusLabel, "Final snapshot");
  assert.match(String(finalAbout?.statusDetail), /locked|read-only/i);

  const ongoing = buildProposalAbout(FALLBACK_PROPOSALS.find((p) => p.id === "bip54")!);
  assert.equal(ongoing?.status, "ongoing");
  assert.equal(ongoing?.statusLabel, "Ongoing");
  assert.equal(ongoing?.statusDetail, "");
});

test("buildProposalAbout returns null for missing proposal", () => {
  assert.equal(buildProposalAbout(null), null);
  assert.equal(buildProposalAbout(undefined), null);
  assert.equal(buildProposalAbout({ id: "", shortName: "", title: "", description: "", status: "ongoing" }), null);
});
