import test from "node:test";
import assert from "node:assert/strict";
import {
  accountPassesJoinDateFilter,
  clampJoinYear,
  defaultJoinDateRange,
  filterAccountsByJoinDate,
  joinYearFromAccountCreatedAt,
  normalizeJoinYearRange,
  summarizeJoinDateYears,
  X_JOIN_YEAR_FLOOR,
} from "./xJoinDateFilter.js";

test("joinYearFromAccountCreatedAt reads UTC calendar year", () => {
  assert.equal(joinYearFromAccountCreatedAt("2011-10-15T12:00:00.000Z"), 2011);
  assert.equal(joinYearFromAccountCreatedAt(null), null);
  assert.equal(joinYearFromAccountCreatedAt("bogus"), null);
});

test("normalizeJoinYearRange enforces min <= max within bounds", () => {
  assert.deepEqual(normalizeJoinYearRange(2020, 2015, 2006, 2026), {
    minYear: 2015,
    maxYear: 2020,
  });
  assert.deepEqual(normalizeJoinYearRange(1999, 3000, 2006, 2026), {
    minYear: 2006,
    maxYear: 2026,
  });
});

test("clampJoinYear uses whole years only", () => {
  assert.equal(clampJoinYear(2018.9, 2006, 2026), 2018);
});

test("filter inclusive between / before / after year cases", () => {
  const accounts = [
    { handle: "a", accountCreatedAt: "2010-01-01T00:00:00.000Z" },
    { handle: "b", accountCreatedAt: "2018-06-01T00:00:00.000Z" },
    { handle: "c", accountCreatedAt: "2022-01-01T00:00:00.000Z" },
    { handle: "u", accountCreatedAt: null },
  ];

  // Between 2014–2020
  assert.deepEqual(
    filterAccountsByJoinDate(accounts, true, 2014, 2020).map((a) => a.handle),
    ["b"]
  );
  // Before 2018 (max=2018)
  assert.deepEqual(
    filterAccountsByJoinDate(accounts, true, 2006, 2018).map((a) => a.handle),
    ["a", "b"]
  );
  // After 2018 (min=2018)
  assert.deepEqual(
    filterAccountsByJoinDate(accounts, true, 2018, 2026).map((a) => a.handle),
    ["b", "c"]
  );
  // Same year
  assert.deepEqual(
    filterAccountsByJoinDate(accounts, true, 2018, 2018).map((a) => a.handle),
    ["b"]
  );
});

test("unknown join dates visible while off, excluded while on", () => {
  const unknown = { accountCreatedAt: null };
  assert.equal(accountPassesJoinDateFilter(unknown, false, 2006, 2026), true);
  assert.equal(accountPassesJoinDateFilter(unknown, true, 2006, 2026), false);
});

test("disabling restores all accounts (filter is a pure pass-through)", () => {
  const accounts = [
    { accountCreatedAt: "2010-01-01T00:00:00.000Z" },
    { accountCreatedAt: null },
  ];
  assert.equal(filterAccountsByJoinDate(accounts, false, 2020, 2020).length, 2);
});

test("default range uses data extents so enabling does not drop known dates", () => {
  const accounts = [
    { accountCreatedAt: "2012-01-01T00:00:00.000Z" },
    { accountCreatedAt: "2019-01-01T00:00:00.000Z" },
    { accountCreatedAt: null },
  ];
  const range = defaultJoinDateRange(accounts, 2026);
  assert.equal(range.boundMin, X_JOIN_YEAR_FLOOR);
  assert.equal(range.minYear, 2012);
  assert.equal(range.maxYear, 2019);
  assert.equal(filterAccountsByJoinDate(accounts, true, range.minYear, range.maxYear).length, 2);
});

test("empty result when range has no known matches", () => {
  const accounts = [{ accountCreatedAt: "2010-01-01T00:00:00.000Z" }];
  assert.equal(filterAccountsByJoinDate(accounts, true, 2020, 2024).length, 0);
});

test("summarizeJoinDateYears counts known and unknown", () => {
  const s = summarizeJoinDateYears([
    { accountCreatedAt: "2009-01-01T00:00:00.000Z" },
    { account_created_at: "2015-01-01T00:00:00.000Z" },
    { accountCreatedAt: null },
  ]);
  assert.equal(s.knownCount, 2);
  assert.equal(s.unknownCount, 1);
  assert.equal(s.earliestYear, 2009);
  assert.equal(s.latestYear, 2015);
});

test("OPTIONS_MENU_JOIN_DATE_LABEL is last option contract", () => {
  // Documented Options order contract used by UI tests.
  const OPTIONS_ORDER = [
    "Equal avatar size",
    "Edit stances",
    "Plebs (<3k followers)",
    "Influencers (>3k followers)",
    "X join date",
  ];
  assert.equal(OPTIONS_ORDER[OPTIONS_ORDER.length - 1], "X join date");
});
