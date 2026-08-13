#!/usr/bin/env node
/**
 * Generate public/og-card.png (1200x630) from a simple branded HTML canvas via Playwright.
 * Run: node scripts/generate-og-card.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "public", "og-card.png");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  canvas { display: block; width: 1200px; height: 630px; }
</style>
</head>
<body>
<canvas id="c" width="1200" height="630"></canvas>
<script>
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(600, 80, 40, 600, 280, 520);
  g.addColorStop(0, '#1e3a5f');
  g.addColorStop(0.45, '#0b1220');
  g.addColorStop(1, '#020617');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1200, 630);
  const stars = [[220,420,3],[340,500,2],[980,180,2.5],[1080,390,2],[860,520,1.8]];
  for (const [x,y,r] of stars) {
    ctx.beginPath();
    ctx.fillStyle = 'rgba(147,197,253,0.7)';
    ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fill();
  }
  ctx.save();
  ctx.translate(200, 240);
  ctx.rotate(Math.PI/4);
  ctx.fillStyle = '#1AAA50';
  ctx.fillRect(-70, -70, 140, 70);
  ctx.fillStyle = '#E81E26';
  ctx.fillRect(-70, 0, 140, 70);
  ctx.restore();
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 64px Georgia, Times New Roman, serif';
  ctx.fillText('Consensus Health', 360, 290);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '500 28px Segoe UI, Helvetica, Arial, sans-serif';
  ctx.fillText('BIP galaxies of public Bitcoin stances', 360, 350);
  const accent = ctx.createLinearGradient(360, 0, 780, 0);
  accent.addColorStop(0, 'rgba(248,113,113,0)');
  accent.addColorStop(0.5, '#93c5fd');
  accent.addColorStop(1, 'rgba(74,222,128,0)');
  ctx.fillStyle = accent;
  ctx.fillRect(360, 380, 420, 3);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 22px Segoe UI, Helvetica, Arial, sans-serif';
  ctx.fillText('consensus.health', 360, 430);
</script>
</body>
</html>`;

mkdirSync(dirname(outPath), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: "load" });
const buf = await page.locator("canvas").screenshot({ type: "png" });
writeFileSync(outPath, buf);
await browser.close();
console.log(`Wrote ${outPath} (${buf.length} bytes)`);
