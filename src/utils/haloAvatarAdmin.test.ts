import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHaloAvatarAdmin,
  haloAvatarFilename,
  haloColorForStance,
  isHaloAvatarAdmin,
  normalizeHaloStance,
} from "./haloAvatarAdmin.ts";
import { STANCE_COLORS } from "./stanceColors.ts";
import {
  coverDrawRect,
  drawHaloAvatar,
  HALO_AVATAR_OUTPUT_SIZE,
  HALO_AVATAR_RING_SAFETY_INSET,
  HALO_AVATAR_RING_WIDTH,
  haloRingLayout,
} from "./haloAvatarCanvas.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
const modalSrc = readFileSync(join(root, "src", "components", "HaloAvatarModal.jsx"), "utf8");

test("isHaloAvatarAdmin accepts only authenticated zndtoshi", () => {
  assert.equal(isHaloAvatarAdmin({ authenticated: true, handle: "zndtoshi" }), true);
  assert.equal(isHaloAvatarAdmin({ authenticated: true, handle: "@zndtoshi" }), true);
  assert.equal(isHaloAvatarAdmin({ authenticated: true, handle: "ZndToshi " }), true);
  assert.equal(isHaloAvatarAdmin({ authenticated: true, username: "@ZNDTOSHI" }), true);
});

test("isHaloAvatarAdmin rejects other users and logged-out state", () => {
  assert.equal(isHaloAvatarAdmin(null), false);
  assert.equal(isHaloAvatarAdmin(undefined), false);
  assert.equal(isHaloAvatarAdmin({ authenticated: false, handle: "zndtoshi" }), false);
  assert.equal(isHaloAvatarAdmin({ authenticated: true, handle: "alice" }), false);
  assert.equal(isHaloAvatarAdmin({ authenticated: true, handle: "zndtoshi_alt" }), false);
  assert.equal(isHaloAvatarAdmin({ handle: "zndtoshi" }), false);
});

test("assertHaloAvatarAdmin rejects unauthorized generation", () => {
  assert.throws(() => assertHaloAvatarAdmin({ authenticated: true, handle: "alice" }), /authorized admin/);
  assert.throws(() => assertHaloAvatarAdmin(null), /authorized admin/);
  assert.doesNotThrow(() => assertHaloAvatarAdmin({ authenticated: true, handle: "@zndtoshi" }));
});

test("halo colors map approve/neutral/against via STANCE_COLORS", () => {
  assert.equal(haloColorForStance("against"), STANCE_COLORS.against);
  assert.equal(haloColorForStance("neutral"), STANCE_COLORS.neutral);
  assert.equal(haloColorForStance("approve"), STANCE_COLORS.approve);
  assert.equal(normalizeHaloStance("support"), "approve");
  assert.equal(normalizeHaloStance("AGAINST"), "against");
  assert.equal(normalizeHaloStance(""), "neutral");
});

test("filename contains normalized stance", () => {
  assert.equal(haloAvatarFilename("against"), "zndtoshi-consensus-halo-against.png");
  assert.equal(haloAvatarFilename("Approve"), "zndtoshi-consensus-halo-approve.png");
  assert.equal(haloAvatarFilename("support"), "zndtoshi-consensus-halo-approve.png");
  assert.equal(haloAvatarFilename("neutral"), "zndtoshi-consensus-halo-neutral.png");
});

test("coverDrawRect preserves aspect with center cover (not contain)", () => {
  const wide = coverDrawRect(200, 100, 100);
  // Cover scales by the larger axis: height fills, width overflows.
  assert.ok(wide.dw >= 100 - 0.01);
  assert.ok(wide.dh >= 100 - 0.01);
  assert.ok(wide.dw > wide.dh); // wide source overflows horizontally
  assert.ok(wide.dx < 0); // centered overflow cropped, not letterboxed
  const tall = coverDrawRect(100, 200, 100);
  assert.ok(tall.dw >= 100 - 0.01);
  assert.ok(tall.dh >= 100 - 0.01);
  assert.ok(tall.dh > tall.dw);
  assert.ok(tall.dy < 0);
  // Contain would leave empty bands; cover never underfills either axis.
  assert.ok(Math.min(wide.dw, wide.dh) >= 100 - 0.01);
  assert.ok(Math.min(tall.dw, tall.dh) >= 100 - 0.01);
});

test("halo export is 1024 with no padding; ring stays inside canvas", () => {
  assert.equal(HALO_AVATAR_OUTPUT_SIZE, 1024);
  const layout = haloRingLayout();
  assert.equal(layout.size, 1024);
  assert.equal(layout.cx, 512);
  assert.equal(layout.cy, 512);
  assert.equal(layout.cropRadius, 512);
  assert.equal(layout.ringWidth, HALO_AVATAR_RING_WIDTH);
  assert.ok(HALO_AVATAR_RING_WIDTH >= 18 && HALO_AVATAR_RING_WIDTH <= 24);
  assert.ok(HALO_AVATAR_RING_SAFETY_INSET >= 2 && HALO_AVATAR_RING_SAFETY_INSET <= 4);
  assert.equal(
    layout.ringCenterRadius,
    512 - HALO_AVATAR_RING_WIDTH / 2 - HALO_AVATAR_RING_SAFETY_INSET
  );
  // Outer edge of stroke must remain inside the canvas / circular crop.
  const outerStrokeEdge = layout.ringCenterRadius + layout.ringWidth / 2;
  assert.ok(outerStrokeEdge <= 512);
  assert.ok(outerStrokeEdge <= layout.cropRadius);
  // No large export padding: crop radius is half the canvas (avatar fills square).
  assert.equal(layout.cropRadius, layout.size / 2);
});

test("drawHaloAvatar uses high-quality smoothing and full-bleed cover draw", () => {
  const calls = [];
  const gradients = [];
  const drawImageCalls = [];
  const arcCalls = [];
  const ctx = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    globalAlpha: 0.5,
    globalCompositeOperation: "lighter",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    save() {
      calls.push("save");
    },
    restore() {
      calls.push("restore");
    },
    setTransform(...args) {
      calls.push(["setTransform", ...args]);
    },
    clearRect(...args) {
      calls.push(["clearRect", ...args]);
    },
    beginPath() {
      calls.push("beginPath");
    },
    closePath() {
      calls.push("closePath");
    },
    arc(...args) {
      arcCalls.push(args);
      calls.push(["arc", ...args]);
    },
    clip() {
      calls.push("clip");
    },
    drawImage(...args) {
      drawImageCalls.push(args);
      calls.push(["drawImage", args.length]);
    },
    createRadialGradient(...args) {
      const g = {
        stops: [],
        addColorStop(offset, color) {
          this.stops.push([offset, color]);
        },
      };
      gradients.push({ args, g });
      return g;
    },
    fill() {
      calls.push("fill");
    },
    stroke() {
      calls.push("stroke");
    },
  };
  const fakeImg = { width: 64, height: 64, naturalWidth: 64, naturalHeight: 64 };
  drawHaloAvatar(ctx, { image: fakeImg, stanceColor: "#ef4444", size: HALO_AVATAR_OUTPUT_SIZE });
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(ctx.imageSmoothingQuality, "high");
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === "clearRect" && c[1] === 0 && c[3] === 1024));
  assert.ok(calls.includes("clip"));
  assert.equal(drawImageCalls.length, 1);
  // Full-bleed cover into 1024×1024 (dest size = canvas, not a shrunk inner circle).
  const di = drawImageCalls[0];
  assert.equal(di.length, 9);
  assert.equal(di[5] + di[7] / 2, 512); // centered x
  assert.equal(di[6] + di[8] / 2, 512); // centered y
  assert.ok(di[7] >= 1024 - 0.01);
  assert.ok(di[8] >= 1024 - 0.01);
  assert.ok(gradients.length >= 1);
  // Inward glow: inner radius < outer radius (createRadialGradient x0,y0,r0,x1,y1,r1)
  const [, , innerR, , , outerR] = gradients[0].args;
  assert.ok(innerR < outerR);
  assert.equal(outerR, 512);
  // Crisp ring arc uses the flush-to-edge centerline radius.
  const layout = haloRingLayout();
  assert.ok(arcCalls.some((a) => a[2] === layout.ringCenterRadius));
});

test("Account menu wires Download Halo Avatar behind isHaloAvatarAdmin", () => {
  assert.match(appSrc, /Download Halo Avatar/);
  assert.match(appSrc, /isHaloAvatarAdmin/);
  assert.match(appSrc, /assertHaloAvatarAdmin|HaloAvatarModal/);
  assert.match(appSrc, /haloAvatarOpen|setHaloAvatarOpen/);
  // Must appear in the authenticated account menu region near Log out.
  const menuIdx = appSrc.indexOf('aria-label="Account"');
  const logoutIdx = appSrc.indexOf(">Log out<", menuIdx);
  const itemIdx = appSrc.indexOf("Download Halo Avatar", menuIdx);
  assert.ok(menuIdx > 0);
  assert.ok(itemIdx > menuIdx);
  assert.ok(itemIdx < logoutIdx);
});

test("HaloAvatarModal re-checks admin auth before download", () => {
  assert.match(modalSrc, /assertHaloAvatarAdmin/);
  assert.match(modalSrc, /renderHaloAvatarPngBlob|drawHaloAvatar/);
  assert.match(modalSrc, /Download PNG/);
});
