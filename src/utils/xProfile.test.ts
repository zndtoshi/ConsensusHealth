import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildXProfileUrl,
  formatFollowerLabel,
  normalizeXHandle,
} from "../../src/utils/xProfile.ts";

describe("xProfile utils", () => {
  it("strips leading @ and builds x.com URLs", () => {
    assert.equal(normalizeXHandle("@avg_gary"), "avg_gary");
    assert.equal(buildXProfileUrl("@avg_gary"), "https://x.com/avg_gary");
    assert.equal(buildXProfileUrl("avg_gary"), "https://x.com/avg_gary");
  });

  it("rejects unsafe handles", () => {
    assert.equal(buildXProfileUrl("bad handle"), null);
    assert.equal(buildXProfileUrl("evil/../x"), null);
    assert.equal(buildXProfileUrl(""), null);
  });

  it("formats follower labels", () => {
    assert.equal(formatFollowerLabel(1), "1 follower");
    assert.equal(
      formatFollowerLabel(12430),
      `${new Intl.NumberFormat().format(12430)} followers`
    );
    assert.equal(formatFollowerLabel(null), "Followers unavailable");
    assert.equal(formatFollowerLabel(undefined), "Followers unavailable");
  });
});
