import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildStanceCsvContent,
  buildStanceCsvExport,
  deduplicateCsvRowsByHandle,
  escapeCsvValue,
  mapCommunityRowToCsvExport,
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

  it("escapes commas, quotes, and formula injection", () => {
    assert.equal(escapeCsvValue("hello"), "hello");
    assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvValue("John, Jr."), '"John, Jr."');
    assert.equal(escapeCsvValue("=1+1"), "\"'=1+1\"");
    assert.equal(escapeCsvValue("@mention"), "\"'@mention\"");
  });

  it("builds CSV with only handle and display_name plus UTF-8 BOM", () => {
    const content = buildStanceCsvContent([
      {
        handle: "alice",
        display_name: "Alice",
        followers_count: 42,
      },
      {
        handle: "johnjr",
        display_name: "John, Jr.",
        followers_count: 10,
      },
    ]);
    assert.ok(content.startsWith("\uFEFF"));
    assert.equal(content, "\uFEFFhandle,display_name\r\nalice,Alice\r\njohnjr,\"John, Jr.\"\r\n");
    assert.ok(!content.includes("followers_count"));
    assert.ok(!content.includes("profile_url"));
    assert.ok(!content.includes("avatar_url"));
    assert.ok(!content.includes("updated_at"));
  });

  it("exports only matching stance from merged rows", () => {
    const merged = [
      { handle: "a1", name: "A1", stance: "against", followers_count: 10 },
      { handle: "n1", name: "N1", stance: "neutral", followers_count: 20 },
      { handle: "p1", name: "P1", stance: "approve", followers_count: 30 },
    ];
    const against = buildStanceCsvExport(merged, "against");
    assert.ok(against.content.includes("a1,A1"));
    assert.ok(!against.content.includes("n1"));
    assert.ok(!against.content.includes("p1"));
    assert.match(against.filename, /^consensus-health-against-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
