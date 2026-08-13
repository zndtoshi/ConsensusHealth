import test from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_DISTANT_SLOTS, distantLayout } from "../utils/distantGalaxyLayout.js";

test("canonical BIP slots are fixed corners independent of index/order", () => {
  assert.equal(distantLayout("bip110", 0).x, CANONICAL_DISTANT_SLOTS.bip110.x);
  assert.equal(distantLayout("bip110", 99).x, CANONICAL_DISTANT_SLOTS.bip110.x);
  assert.deepEqual(distantLayout("BIP54"), CANONICAL_DISTANT_SLOTS.bip54);
  assert.deepEqual(distantLayout("bip448", 3), CANONICAL_DISTANT_SLOTS.bip448);
  assert.deepEqual(distantLayout("bip460", 1), CANONICAL_DISTANT_SLOTS.bip460);

  // Corners: BIP110 top-left, BIP54 bottom-left, BIP448 top-right, BIP460 bottom-right.
  assert.ok(CANONICAL_DISTANT_SLOTS.bip110.x < 50 && CANONICAL_DISTANT_SLOTS.bip110.y < 40);
  assert.ok(CANONICAL_DISTANT_SLOTS.bip54.x < 50 && CANONICAL_DISTANT_SLOTS.bip54.y > 60);
  assert.ok(CANONICAL_DISTANT_SLOTS.bip448.x > 50 && CANONICAL_DISTANT_SLOTS.bip448.y < 40);
  assert.ok(CANONICAL_DISTANT_SLOTS.bip460.x > 50 && CANONICAL_DISTANT_SLOTS.bip460.y > 60);
});

test("hiding the active BIP leaves other three poses unchanged", () => {
  const ids = ["bip110", "bip54", "bip448", "bip460"];
  const baseline = Object.fromEntries(ids.map((id) => [id, distantLayout(id)]));
  for (const active of ids) {
    const visible = ids.filter((id) => id !== active);
    for (const id of visible) {
      assert.deepEqual(distantLayout(id), baseline[id], `${id} moved while ${active} active`);
    }
  }
});

test("distant galaxy centers stay inset so labels fit 1280 and mobile widths", () => {
  const ids = ["bip54", "bip110", "bip448", "bip460"];
  for (const id of ids) {
    const pos = distantLayout(id);
    assert.ok(pos.x >= 10 && pos.x <= 90, `${id} x=${pos.x}`);
    assert.ok(pos.y >= 12 && pos.y <= 86, `${id} y=${pos.y}`);
    const leftPx = (pos.x / 100) * 1280;
    assert.ok(leftPx - 80 > 0, `desktop left clip risk for ${id}`);
    assert.ok(leftPx + 80 < 1280, `desktop right clip risk for ${id}`);
    const mobileLeft = (pos.x / 100) * 390;
    assert.ok(mobileLeft - 56 > -8, `mobile control clip risk for ${id}`);
  }
});

test("unknown BIP fallback does not alter canonical slots", () => {
  const before = { ...CANONICAL_DISTANT_SLOTS.bip110 };
  const unknown = distantLayout("bip999");
  assert.notDeepEqual(unknown, before);
  assert.deepEqual(distantLayout("bip110"), before);
  assert.ok(unknown.x >= 10 && unknown.x <= 90);
});
