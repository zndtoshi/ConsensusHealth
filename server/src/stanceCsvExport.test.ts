import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStanceCsvContent,
  buildStanceCsvExport,
  buildStanceCsvRows,
  csvEscape,
  deduplicateCsvRowsByHandle,
  mapCommunityRowToCsvExport,
  serializeStanceCsv,
  sortCsvRows,
} from "./stanceCsvExport.js";

describe("stanceCsvExport", () => {
  it("maps community rows without x_user_id or extra export fields", () => {
    const row = mapCommunityRowToCsvExport({
      x_user_id: "12345",
      handle: "@Alice",
      name: "Alice Example",
      followers_count: 1000,
      avatar_url: "https://pbs.twimg.com/a.jpg",
      stance: "approve",
      updated_at: "2026-07-13T10:00:00.000Z",
    });
    assert.ok(row);
    assert.equal(row.handle, "alice");
    assert.equal(row.display_name, "Alice Example");
    assert.equal(row.followers_count, 1000);
    assert.equal("x_user_id" in row, false);
    assert.equal("profile_url" in row, false);
    assert.equal("avatar_url" in row, false);
    assert.equal("updated_at" in row, false);
  });

  it("does not modify or normalize display names", () => {
    const row = mapCommunityRowToCsvExport({
      handle: "needcreations",
      name: "→ Cryptic Beer Lounge Derry, NH Feb. 20 6-8pm",
      stance: "neutral",
      followers_count: 1,
    });
    assert.ok(row);
    assert.equal(row.display_name, "→ Cryptic Beer Lounge Derry, NH Feb. 20 6-8pm");
  });

  it("skips unset stances", () => {
    const row = mapCommunityRowToCsvExport({
      handle: "bob",
      name: "Bob",
      stance: "",
    });
    assert.equal(row, null);
  });

  it("deduplicates by lowercase handle keeping higher followers", () => {
    const rows = deduplicateCsvRowsByHandle([
      {
        handle: "alice",
        display_name: "A",
        followers_count: 100,
      },
      {
        handle: "Alice",
        display_name: "B",
        followers_count: 200,
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].display_name, "B");
  });

  it("sorts by followers desc then handle asc", () => {
    const rows = sortCsvRows([
      {
        handle: "zebra",
        display_name: "",
        followers_count: 10,
      },
      {
        handle: "alpha",
        display_name: "",
        followers_count: 100,
      },
      {
        handle: "beta",
        display_name: "",
        followers_count: 100,
      },
    ]);
    assert.deepEqual(
      rows.map((r) => r.handle),
      ["alpha", "beta", "zebra"]
    );
  });

  it("csvEscape always quotes and doubles embedded quotes", () => {
    assert.equal(csvEscape("hello"), '"hello"');
    assert.equal(csvEscape('Arthur "lynch mob" van Pelt'), '"Arthur ""lynch mob"" van Pelt"');
    assert.equal(csvEscape("John, Jr."), '"John, Jr."');
    assert.equal(csvEscape(""), '""');
  });

  it("serializes spaces, commas, quotes, emojis, hashtags, and Unicode as single fields", () => {
    const rows = buildStanceCsvRows([
      {
        handle: "grassfedbitcoin",
        display_name: "Mechanic #BIP-110",
        followers_count: 300,
      },
      {
        handle: "arthur_van_pelt",
        display_name: 'Arthur "lynch mob" van Pelt',
        followers_count: 200,
      },
      {
        handle: "needcreations",
        display_name: "→ Cryptic Beer Lounge Derry, NH Feb. 20 6-8pm",
        followers_count: 100,
      },
      {
        handle: "btcsessions",
        display_name: "BTC Sessions 😎",
        followers_count: 50,
      },
      {
        handle: "jimmysong",
        display_name: "Jimmy Song (송재준)",
        followers_count: 40,
      },
    ]);

    const content = serializeStanceCsv(rows);
    assert.equal(
      content,
      [
        "\uFEFF" + '"handle","display_name"',
        '"grassfedbitcoin","Mechanic #BIP-110"',
        '"arthur_van_pelt","Arthur ""lynch mob"" van Pelt"',
        '"needcreations","→ Cryptic Beer Lounge Derry, NH Feb. 20 6-8pm"',
        '"btcsessions","BTC Sessions 😎"',
        '"jimmysong","Jimmy Song (송재준)"',
      ].join("\r\n")
    );

    assert.ok(!content.includes("\t"));
    assert.ok(!content.includes("followers_count"));
  });

  it("builds CSV with only two quoted columns and UTF-8 BOM", () => {
    const content = buildStanceCsvContent([
      {
        handle: "alice",
        display_name: "Alice",
        followers_count: 42,
      },
    ]);
    assert.equal(content, '\uFEFF"handle","display_name"\r\n"alice","Alice"');
  });

  it("exports only matching stance from merged rows", () => {
    const merged = [
      { handle: "a1", name: "A1", stance: "against", followers_count: 10 },
      { handle: "n1", name: "N1", stance: "neutral", followers_count: 20 },
      { handle: "p1", name: "P1", stance: "approve", followers_count: 30 },
    ];
    const against = buildStanceCsvExport(merged, "against");
    assert.ok(against.content.includes('"a1","A1"'));
    assert.ok(!against.content.includes("n1"));
    assert.ok(!against.content.includes("p1"));
    assert.match(against.filename, /^consensus-health-against-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
