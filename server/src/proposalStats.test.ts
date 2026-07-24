import test from "node:test";
import assert from "node:assert/strict";
import { buildStatsSql } from "./proposalStats.js";
import { DEFAULT_PROPOSAL_ID } from "./proposalCatalog.js";
import { buildStanceCsvExport } from "./stanceCsvExport.js";

test("bip110 stats SQL uses legacy community_users tables", () => {
  const sql = buildStatsSql(DEFAULT_PROPOSAL_ID);
  assert.equal(sql.params.length, 0);
  assert.match(sql.aggSql, /FROM community_users/);
  assert.match(sql.changedEverSql, /FROM stance_history/);
});

test("bip54 stats SQL scopes to user_proposal tables", () => {
  const sql = buildStatsSql("bip54");
  assert.deepEqual(sql.params, ["bip54"]);
  assert.match(sql.aggSql, /user_proposal_stances/);
  assert.match(sql.changedEverSql, /user_proposal_stance_history/);
  assert.match(sql.aggSql, /proposal_id = \$1/);
});

test("empty proposal CSV still includes headers", () => {
  const { content, filename } = buildStanceCsvExport([], "against");
  assert.match(filename, /against/);
  assert.match(content, /handle/);
  assert.match(content, /display_name/);
});
