import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphemeLength,
  isReservedSeedName,
  NAME_THE_FORK_MAX_CHARS,
  NAME_THE_FORK_PATH,
  NAME_THE_FORK_SEEDS,
  NAME_THE_FORK_TITLE,
  NAME_THE_FORK_MIGRATION_VERSION_V2,
  normalizeCandidateName,
} from "./nameTheFork.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Name the Fork seeds are exactly the four required display names", () => {
  assert.deepEqual(
    NAME_THE_FORK_SEEDS.map((s) => s.displayName),
    ["BcashJr", "BdashJr", "Bdash", "Bitcoin110"]
  );
  assert.equal(NAME_THE_FORK_PATH, "/name-the-fork");
  assert.equal(NAME_THE_FORK_TITLE, "Name the PoW change fork");
});

test("normalizeCandidateName enforces trim, length, charset, and uniqueness key", () => {
  assert.equal(normalizeCandidateName("  Bdash  ").ok, true);
  const ok = normalizeCandidateName("Bitcoin Core");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.displayName, "Bitcoin Core");
    assert.equal(ok.normalizedKey, "bitcoin core");
    assert.equal(ok.length, 12);
  }
  assert.equal(normalizeCandidateName("").ok, false);
  assert.equal(normalizeCandidateName("a".repeat(NAME_THE_FORK_MAX_CHARS + 1)).ok, false);
  assert.equal(normalizeCandidateName("@bdash").ok, false);
  assert.equal(normalizeCandidateName("https://x.com/x").ok, false);
  assert.equal(normalizeCandidateName("<script>").ok, false);
  assert.equal(normalizeCandidateName("-bad").ok, false);
  assert.equal(normalizeCandidateName("bad--name").ok, false);
  assert.equal(normalizeCandidateName("only🚀").ok, false);
  assert.equal(graphemeLength("å"), 1);
});

test("seed names are reserved under case-insensitive normalization", () => {
  const bdash = normalizeCandidateName("bdash");
  assert.equal(bdash.ok, true);
  if (bdash.ok) assert.equal(isReservedSeedName(bdash.normalizedKey), true);
  const other = normalizeCandidateName("MyFork");
  assert.equal(other.ok, true);
  if (other.ok) assert.equal(isReservedSeedName(other.normalizedKey), false);
});

test("server wires moderation schema, approve/reject routes, and display title", () => {
  const indexSrc = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  const modSrc = fs.readFileSync(path.join(here, "nameTheFork.ts"), "utf8");
  const deletionSrc = fs.readFileSync(path.join(here, "accountDeletion.ts"), "utf8");
  assert.match(indexSrc, /ensureNameTheForkSchema/);
  assert.match(indexSrc, /\/api\/name-the-fork/);
  assert.match(indexSrc, /\/api\/name-the-fork\/vote/);
  assert.match(indexSrc, /\/api\/name-the-fork\/candidates/);
  assert.match(indexSrc, /\/api\/name-the-fork\/admin\/hide/);
  assert.match(indexSrc, /\/api\/name-the-fork\/admin\/approve/);
  assert.match(indexSrc, /\/api\/name-the-fork\/admin\/reject/);
  assert.match(modSrc, /name_the_fork_candidates/);
  assert.match(modSrc, /name_the_fork_votes/);
  assert.match(modSrc, /moderation_status/);
  assert.match(modSrc, /NAME_THE_FORK_MIGRATION_VERSION_V2/);
  assert.equal(NAME_THE_FORK_MIGRATION_VERSION_V2.includes("moderation"), true);
  assert.match(modSrc, /NTF_UNIQUE_NORMALIZED_ACTIVE/);
  assert.match(modSrc, /NTF_UNIQUE_ONE_ACTIVE_CUSTOM/);
  assert.match(modSrc, /approveNameTheForkCandidate/);
  assert.match(modSrc, /rejectNameTheForkCandidate/);
  assert.match(modSrc, /pending_suggestions/);
  assert.match(modSrc, /my_submission/);
  assert.match(modSrc, /Name the PoW change fork/);
  assert.doesNotMatch(modSrc, /user_proposal_stances/);
  assert.match(modSrc, /pg_advisory_xact_lock/);
  assert.match(deletionSrc, /DELETE FROM name_the_fork_votes/);
  assert.match(deletionSrc, /proposer_x_user_id = NULL/);
});
