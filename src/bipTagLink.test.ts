import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(srcDir, "App.jsx"), "utf8");
const cssSrc = readFileSync(join(srcDir, "index.css"), "utf8");

test("BIP-110 header badge links to the official BIP mediawiki doc", () => {
  assert.match(
    appSrc,
    /href="https:\/\/github\.com\/bitcoin\/bips\/blob\/master\/bip-0110\.mediawiki"/
  );
  assert.match(appSrc, /target="_blank"/);
  assert.match(appSrc, /rel="noopener noreferrer"/);
});

test("BIP-110 badge exposes tooltip, aria-label, and interactive class", () => {
  assert.match(appSrc, /className="bipTagLink"/);
  assert.match(appSrc, /title="View the official BIP-110 proposal on GitHub"/);
  assert.match(appSrc, /aria-label="Open official BIP-110 proposal on GitHub"/);
  assert.match(appSrc, /bipTagLink__icon/);
});

test("BIP-110 badge CSS includes hover lift, focus ring, and reduced motion", () => {
  assert.match(cssSrc, /\.bipTagLink\s*\{/);
  assert.match(cssSrc, /cursor:\s*pointer/);
  assert.match(cssSrc, /translateY\(-1px\)/);
  assert.match(cssSrc, /\.bipTagLink:focus-visible/);
  assert.match(cssSrc, /prefers-reduced-motion:\s*reduce/);
  assert.match(cssSrc, /transition:[\s\S]{0,80}180ms/);
});
