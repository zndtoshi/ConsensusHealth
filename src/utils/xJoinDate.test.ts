import test from "node:test";
import assert from "node:assert/strict";
import { formatXJoinDate } from "./xJoinDate.js";

test("formatXJoinDate renders month and year", () => {
  assert.equal(formatXJoinDate("2011-10-15T12:00:00.000Z"), "X join date: October 2011");
});

test("formatXJoinDate returns empty for missing/invalid", () => {
  assert.equal(formatXJoinDate(null), "");
  assert.equal(formatXJoinDate(""), "");
  assert.equal(formatXJoinDate("not-a-date"), "");
});
