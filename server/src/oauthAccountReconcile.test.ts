import assert from "node:assert/strict";
import { test } from "node:test";
import { pickWinningProposalStance } from "./oauthAccountReconcile.js";

test("pickWinningProposalStance prefers non-null stance, else newer timestamp", () => {
  const target = {
    x_user_id: "a",
    proposal_id: "bip54",
    stance: "neutral",
    updated_at: "2020-01-01T00:00:00.000Z",
  };
  const source = {
    x_user_id: "b",
    proposal_id: "bip54",
    stance: "against",
    updated_at: "2024-01-01T00:00:00.000Z",
  };
  assert.equal(pickWinningProposalStance(target, source)?.stance, "against");
  assert.equal(
    pickWinningProposalStance(undefined, source)?.x_user_id,
    "b"
  );
  assert.equal(
    pickWinningProposalStance(target, undefined)?.x_user_id,
    "a"
  );
});

test("pickWinningProposalStance keeps target on equal timestamps", () => {
  const ts = "2024-06-01T00:00:00.000Z";
  const target = { x_user_id: "a", proposal_id: "bip54", stance: "approve", updated_at: ts };
  const source = { x_user_id: "b", proposal_id: "bip54", stance: "against", updated_at: ts };
  assert.equal(pickWinningProposalStance(target, source)?.x_user_id, "a");
});

test("pickWinningProposalStance copies source-only rows", () => {
  const source = {
    x_user_id: "b",
    proposal_id: "bip448",
    stance: "neutral",
    updated_at: "2024-01-01T00:00:00.000Z",
  };
  assert.deepEqual(pickWinningProposalStance(undefined, source), source);
});
