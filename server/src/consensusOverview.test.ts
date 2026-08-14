import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryConsensusOverview } from "./consensusOverview.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function mockPool(handlers) {
  return {
    async query(sql, params) {
      const key = String(sql).includes("COUNT(DISTINCT")
        ? "unique"
        : String(sql).includes("GROUP BY")
          ? "group"
          : "other";
      const fn = handlers[key] || handlers.default;
      return fn(sql, params);
    },
  };
}

test("queryConsensusOverview aggregates stance rows and unique participants", async () => {
  const pool = mockPool({
    group: async (_sql, params) => {
      assert.deepEqual(params[0].sort(), ["bip110", "bip54", "bip448", "bip460"].sort());
      return {
        rows: [
          {
            proposal_id: "bip54",
            total_users_with_stance: 3,
            against: 1,
            neutral: 1,
            approve: 1,
          },
          {
            proposal_id: "bip448",
            total_users_with_stance: 2,
            against: 0,
            neutral: 0,
            approve: 2,
          },
        ],
      };
    },
    unique: async (_sql, params) => {
      assert.deepEqual(params[0].sort(), ["bip54", "bip448", "bip460"].sort());
      return { rows: [{ unique_participants: 4, stance_selections: 5 }] };
    },
  });

  const payload = await queryConsensusOverview(pool, {
    ongoingIds: ["bip54", "bip448", "bip460"],
    completedIds: ["bip110"],
  });

  assert.equal(payload.aggregates.unique_participants, 4);
  assert.equal(payload.aggregates.stance_selections, 5);
  assert.equal(payload.proposals.find((p) => p.proposal_id === "bip54")?.approve, 1);
  assert.equal(payload.proposals.find((p) => p.proposal_id === "bip110")?.total_users_with_stance, 0);
  assert.ok(!payload.ongoing_proposal_ids.includes("bip110"));
});

test("consensus overview route is registered against user_proposal_stances", () => {
  const indexSrc = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  const overviewSrc = fs.readFileSync(path.join(here, "consensusOverview.ts"), "utf8");
  assert.match(indexSrc, /\/api\/consensus-overview/);
  assert.match(indexSrc, /queryConsensusOverview/);
  assert.match(overviewSrc, /user_proposal_stances/);
  assert.doesNotMatch(overviewSrc, /followers_count/);
});
