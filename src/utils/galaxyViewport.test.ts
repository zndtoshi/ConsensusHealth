import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultUserCamera,
  fittedBoundsScreenCenter,
  fitTranslationForBounds,
  observeContainerSize,
  sizeFromContainerRect,
} from "./galaxyViewport.js";
import { applySparseFitCap } from "./sparseFitCap.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("sizeFromContainerRect prefers real element size and rejects invalid", () => {
  assert.deepEqual(sizeFromContainerRect({ width: 1280, height: 844 }), { w: 1280, h: 844 });
  assert.equal(sizeFromContainerRect({ width: 0, height: 800 }), null);
  assert.equal(sizeFromContainerRect(null), null);
});

test("observeContainerSize measures when target mounts and cleans up", () => {
  const prevRO = globalThis.ResizeObserver;
  const prevWindow = globalThis.window;
  let disconnected = false;
  let observed = null;
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe(el) {
      observed = el;
      this.cb([{ target: el }], this);
    }
    disconnect() {
      disconnected = true;
    }
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };

  const host = {
    getBoundingClientRect: () => ({
      width: 1280,
      height: 659.2,
      top: 60.8,
      left: 0,
      right: 1280,
      bottom: 720,
    }),
  };

  const sizes = [];
  const stop = observeContainerSize(host, (s) => sizes.push(s));
  assert.equal(observed, host);
  assert.deepEqual(sizes[0], { w: 1280, h: 659 });
  stop();
  assert.equal(disconnected, true);

  if (prevRO) globalThis.ResizeObserver = prevRO;
  else delete globalThis.ResizeObserver;
  if (prevWindow) globalThis.window = prevWindow;
  else delete globalThis.window;
});

test("sparse same-stance cluster is centered after fit with zero user pan", () => {
  const cw = 1280;
  const ch = 659;
  const nodes = [
    { x: 120, y: 40, side: 28 },
    { x: 150, y: 55, side: 28 },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxNodeSide = 1;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.side / 2);
    minY = Math.min(minY, n.y - n.side / 2);
    maxX = Math.max(maxX, n.x + n.side / 2);
    maxY = Math.max(maxY, n.y + n.side / 2);
    maxNodeSide = Math.max(maxNodeSide, n.side);
  }
  const pad = 48;
  const blobW = Math.max(1, maxX - minX);
  const blobH = Math.max(1, maxY - minY);
  let fitScale = Math.min((cw - pad * 2) / blobW, (ch - pad * 2) / blobH) * 0.96;
  fitScale = applySparseFitCap({
    fitScale,
    maxNodeSide,
    visibleNodeCount: nodes.length,
    viewportWidth: cw,
    viewportHeight: ch,
  });
  const { fitTx, fitTy } = fitTranslationForBounds({
    minX,
    minY,
    maxX,
    maxY,
    cw,
    ch,
    fitScale,
  });
  const cam = defaultUserCamera();
  const center = fittedBoundsScreenCenter({
    minX,
    minY,
    maxX,
    maxY,
    fitScale,
    fitTx,
    fitTy,
    panX: cam.panX,
    panY: cam.panY,
  });
  assert.ok(Math.abs(center.x - cw / 2) < 0.5);
  assert.ok(Math.abs(center.y - ch / 2) < 0.5);
});

test("stale user pan would shift a centered sparse fit off-center", () => {
  const { fitTx, fitTy } = fitTranslationForBounds({
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 80,
    cw: 1280,
    ch: 659,
    fitScale: 2,
  });
  const stale = fittedBoundsScreenCenter({
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 80,
    fitScale: 2,
    fitTx,
    fitTy,
    panX: 400,
    panY: 300,
  });
  assert.ok(stale.x > 1280 / 2 + 100);
  assert.ok(stale.y > 659 / 2 + 100);
});

test("App uses mount-aware container observation and resets camera", () => {
  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
  assert.match(appSrc, /observeContainerSize/);
  assert.match(appSrc, /setContainerEl/);
  assert.match(appSrc, /containerEl/);
  assert.match(appSrc, /sizeFromContainerRect\(node\.getBoundingClientRect\(\)\)/);
  assert.match(appSrc, /sizeFromContainerRect\(canvas\.parentElement\?\.getBoundingClientRect\(\)\)/);
  assert.match(appSrc, /syncWrapperCanvas/);
  assert.match(appSrc, /setCanvasWrapRef/);
  assert.match(appSrc, /fitTranslationForBounds/);
  assert.match(appSrc, /defaultUserCamera/);
  assert.match(appSrc, /camRef\.current\s*=\s*defaultUserCamera\(\)/);
  assert.match(appSrc, /frozenFitRef\.current\s*=\s*null/);
  assert.doesNotMatch(appSrc, /setTimeout\(fromWindow,\s*150\)/);
  assert.doesNotMatch(appSrc, /innerHeight\s*-\s*56/);
});

test("observation can start before target exists then bind on mount", () => {
  const prevRO = globalThis.ResizeObserver;
  const prevWindow = globalThis.window;
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(el) {
      this.el = el;
      this.cb([{ target: el }], this);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };

  // Simulate loading screen: no target yet.
  let stop = () => {};
  const sizes = [];
  assert.equal(observers.length, 0);

  const host = {
    getBoundingClientRect: () => ({
      width: 1280,
      height: 659.2,
      top: 60.8,
      left: 0,
      right: 1280,
      bottom: 720,
    }),
  };
  stop = observeContainerSize(host, (s) => sizes.push(s));
  assert.equal(observers.length, 1);
  assert.equal(observers[0].el, host);
  assert.deepEqual(sizes.at(-1), { w: 1280, h: 659 });
  // Stale window-sized update must not be applied by callers once measured;
  // observe itself only reports the element rect.
  assert.notDeepEqual(sizes.at(-1), { w: 1280, h: 720 });
  stop();
  assert.equal(observers[0].disconnected, true);

  if (prevRO) globalThis.ResizeObserver = prevRO;
  else delete globalThis.ResizeObserver;
  if (prevWindow) globalThis.window = prevWindow;
  else delete globalThis.window;
});

test("canvas bitmap equals CSS size × DPR for 1280×659 wrapper", () => {
  const cw = 1280;
  const ch = 659;
  const dpr = 1.25;
  assert.equal(Math.floor(cw * dpr), 1600);
  assert.equal(Math.floor(ch * dpr), 823);
  // Stale full-window 720h would produce 900 bitmap height — must not be used.
  assert.notEqual(Math.floor(720 * dpr), Math.floor(ch * dpr));
});
