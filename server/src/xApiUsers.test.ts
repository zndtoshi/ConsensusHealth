import test from "node:test";
import assert from "node:assert/strict";
import { fetchXUsersByIds, fetchXUsersByUsernames } from "./xApiUsers.js";

test("fetchXUsersByIds returns empty map for empty input", async () => {
  const map = await fetchXUsersByIds("unused", []);
  assert.equal(map.size, 0);
});

test("fetchXUsersByUsernames returns empty map for empty input", async () => {
  const map = await fetchXUsersByUsernames("unused", []);
  assert.equal(map.size, 0);
});
