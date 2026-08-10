import test from "node:test";
import assert from "node:assert/strict";
import {
  accountHasSelfReportedStance,
  filterSeedOnlyAccounts,
  filterSelfReportedAccounts,
  isStanceAnalyst,
} from "./stanceAnalyst.js";

test("isStanceAnalyst allows zndtoshi and tonevays only", () => {
  assert.equal(isStanceAnalyst("tonevays"), true);
  assert.equal(isStanceAnalyst("@ToneVays"), true);
  assert.equal(isStanceAnalyst("zndtoshi"), true);
  assert.equal(isStanceAnalyst("someone_else"), false);
  assert.equal(isStanceAnalyst(""), false);
});

test("seed-only filter keeps accounts without self-reported stance changes", () => {
  const rows = [
    { handle: "seeded", hasUserStanceChange: false },
    { handle: "self", hasUserStanceChange: true },
    { handle: "legacy", has_user_stance_change: 1 },
  ];
  assert.deepEqual(
    filterSeedOnlyAccounts(rows).map((r) => r.handle),
    ["seeded"]
  );
  assert.deepEqual(
    filterSelfReportedAccounts(rows).map((r) => r.handle),
    ["self", "legacy"]
  );
  assert.equal(accountHasSelfReportedStance({ hasUserStanceChange: false }), false);
});
