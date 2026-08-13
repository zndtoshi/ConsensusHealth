#!/usr/bin/env node
/**
 * Lightweight smoke: ensure built static assets expose expected public paths.
 * Run after `npm run build:web`. Does not start a browser.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
const required = [
  "index.html",
  "robots.txt",
  "sitemap.xml",
  "og-card.png",
  "favicon.svg",
  "apple-touch-icon.png",
];

if (!existsSync(dist)) {
  console.error("launch-static-smoke: dist/ missing — run npm run build:web first");
  process.exit(1);
}

const missing = required.filter((f) => !existsSync(join(dist, f)));
if (missing.length) {
  console.error("launch-static-smoke: missing from dist:", missing.join(", "));
  process.exit(1);
}

console.log("launch-static-smoke: ok —", required.join(", "));
