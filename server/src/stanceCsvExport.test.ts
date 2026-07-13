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
  it("maps community rows without x_user_id", () => {
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
    assert.equal(row.profile_url, "https://x.com/alice");
    assert.equal(JSON.stringify(row), JSON.stringify(row)); // no x_user_id key
    assert.equal("x_user_id" in row, false);
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
        profile_url: "https://x.com/alice",
        avatar_url: "",
        updated_at: "",
      },
      {
        handle: "Alice",
        display_name: "B",
        followers_count: 200,
        profile_url: "https://x.com/alice",
        avatar_url: "",
        updated_at: "",
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
        profile_url: "https://x.com/zebra",
        avatar_url: "",
        updated_at: "",
      },
      {
        handle: "alpha",
        display_name: "",
        followers_count: 100,
        profile_url: "https://x.com/alpha",
        avatar_url: "",
        updated_at: "",
      },
      {
        handle: "beta",
        display_name: "",
        followers_count: 100,
        profile_url: "https://x.com/beta",
        avatar_url: "",
        updated_at: "",
      },
    ]);
    assert.deepEqual(rows.map((r) => r.handle), ["alpha", "beta", "zebra"]);
  });

  it("escapes commas, quotes, and formula injection", () => {
    assert.equal(escapeCsvValue("hello"), "hello");
    assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvValue("a,b"), '"a,b"');
    assert.equal(escapeCsvValue("=1+1"), "\"'=1+1\"");
    assert.equal(escapeCsvValue("@mention"), "\"'@mention\"");
  });

  it("builds CSV with UTF-8 BOM and header", () => {
    const content = buildStanceCsvContent([
      {
        handle: "alice",
        display_name: "Alice",
        followers_count: 42,
        profile_url: "https://x.com/alice",
        avatar_url: "https://pbs.twimg.com/a.jpg",
        updated_at: "2026-07-13T10:00:00.000Z",
      },
    ]);
    assert.ok(content.startsWith("\uFEFF"));
    assert.ok(content.includes("handle,display_name,followers_count,profile_url,avatar_url,updated_at"));
    assert.ok(content.includes("alice,Alice,42,https://x.com/alice"));
  });

  it("exports only matching stance from merged rows", () => {
    const merged = [
      { handle: "a1", name: "A1", stance: "against", followers_count: 10 },
      { handle: "n1", name: "N1", stance: "neutral", followers_count: 20 },
      { handle: "p1", name: "P1", stance: "approve", followers_count: 30 },
    ];
    const against = buildStanceCsvExport(merged, "against");
    assert.ok(against.content.includes("a1"));
    assert.ok(!against.content.includes(",n1,"));
    assert.ok(!against.content.includes(",p1,"));
    assert.match(against.filename, /^consensus-health-against-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
