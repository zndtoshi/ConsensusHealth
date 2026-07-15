import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceManyBody, forceCenter, forceSimulation, forceX, forceY } from "d3-force";
import { canonicalAvatarSrc, getAvatar, preloadAvatarUrls } from "./utils/avatarCache";
import { fetchCommunityUsers } from "./api/community";
import { applyManualStanceUpdate, isPrivilegedManualEditor } from "./utils/manualEditState";
import {
  AUTH_CHANNEL_NAME,
  LOGIN_RETURN_KEY,
  LOGIN_RETURN_MAX_AGE_MS,
  buildPopupFeatures,
  isAuthResultMessage,
  isAuthSuccessMessage,
} from "./utils/authPopup";
import { fetchNewStanceEvents } from "./api/newStances";
import { NEW_STANCES_HEADING, NEW_STANCES_PUBLIC_ENABLED } from "./config/newStances";
import {
  formatIntroHandleLabel,
  INTRO_LABEL_GAP_PX,
  lockIntroSession,
  clearPlayingSession,
  computeFlightScreenPos,
  computeIntroBandLiftPx,
  computeStagingLayouts,
  computeStagingPanelBounds,
  easeInOutCubic,
  getIntroPhase,
  headingOpacityForPhase,
  stagingPanelOpacityForPhase,
  isIntroNodeHidden,
  matchEventsToIntroItems,
  normalizeIntroEvents,
  parseDebugNewStancesParams,
  pickNewestMarker,
  prefersReducedMotion,
  readLastSeenMarker,
  readPlayingSession,
  resolveFetchAfterEventId,
  resolveShowIntroDecision,
  scheduleFlightTimes,
  shouldDeferIntroForPlayingSession,
  shouldPersistMarker,
  markerEventsFromIntroItems,
  writeLastSeenMarker,
  writePlayingSession,
  INTRO_TIMING,
} from "./utils/newStancesIntro";

// Lazily loaded so the Statistics UI (StatisticsCards, CSV export) and the QR
// library (qrcode.react) are split into separate chunks fetched only on demand.
const StatisticsModal = lazy(() =>
  import("./components/StatisticsModal").then((m) => ({ default: m.StatisticsModal }))
);
const BitcoinQr = lazy(() =>
  import("./components/BitcoinQr").then((m) => ({ default: m.BitcoinQr }))
);

function toInt(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function formatNum(n) {
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString();
}
function safeLower(s) {
  return (s ?? "").toString().toLowerCase();
}

function formatAccountAge(accountCreatedAt) {
  if (!accountCreatedAt) return "";
  const created = new Date(accountCreatedAt);
  if (!Number.isFinite(created.getTime())) return "";
  const now = Date.now();
  const diffMs = Math.max(0, now - created.getTime());
  const years = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
  return `${years}y on X`;
}

function normalizeAccountCreatedAt(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function normalizeHandleToken(s) {
  return safeLower(s).trim().replace(/^@+/, "");
}

function normalizeHandle(handle) {
  return String(handle ?? "").trim().toLowerCase().replace(/^@+/, "");
}

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getFollowersFromUser(user) {
  const fromProfile = toFiniteNumber(user?.profile?.followers_count);
  if (fromProfile != null) return { followers: Math.max(0, fromProfile), source: "profile" };
  const fromTwitterProfile = toFiniteNumber(user?.twitterProfile?.followers_count);
  if (fromTwitterProfile != null) return { followers: Math.max(0, fromTwitterProfile), source: "twitterProfile" };
  const fromStored = toFiniteNumber(user?.followers_count);
  if (fromStored != null) return { followers: Math.max(0, fromStored), source: "followers_count" };
  return { followers: 0, source: "none" };
}

function normalizeTwitterAvatarUrl(url) {
  const u = String(url ?? "").trim();
  if (!u) return "";
  return u.includes("_normal") ? u.replace("_normal", "") : u;
}

function isTwitterAvatarHost(hostname) {
  const h = String(hostname ?? "").toLowerCase();
  return h === "pbs.twimg.com" || h.endsWith(".twimg.com");
}

function maybeProxyAvatarUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!isTwitterAvatarHost(parsed.hostname)) return raw;
    const apiBase = (API_BASE || "").replace(/\/$/, "");
    return `${apiBase}/api/avatar-proxy?url=${encodeURIComponent(raw)}`;
  } catch {
    return raw;
  }
}

function firstNonEmptyAvatarField(obj) {
  if (!obj || typeof obj !== "object") return "";
  const candidates = [
    obj.profile_image_url,
    obj.profileImageUrl,
    obj.avatar_url,
    obj.avatarUrl,
    obj.image,
    obj.photo_url,
  ];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (s) return normalizeTwitterAvatarUrl(s);
  }
  return "";
}

function collectAvatarFieldValues(obj) {
  return {
    profile_image_url: String(obj?.profile_image_url ?? "").trim(),
    profileImageUrl: String(obj?.profileImageUrl ?? "").trim(),
    avatar_url: String(obj?.avatar_url ?? "").trim(),
    avatarUrl: String(obj?.avatarUrl ?? "").trim(),
    image: String(obj?.image ?? "").trim(),
    photo_url: String(obj?.photo_url ?? "").trim(),
    avatar_path: String(obj?.avatar_path ?? "").trim(),
  };
}

function resolveAvatarUrlForAccount(a, baseNoSlash, missingSrc) {
  // Seed accounts keep their locally hosted avatar file (fast, static, cached).
  const path = String(a?.avatar_path ?? "").trim();
  if (path) return canonicalAvatarSrc(`${baseNoSlash}${path}?v=${AVATAR_REV}`);
  // Everyone else: do NOT fetch a remote image (that routes through the server
  // avatar proxy and slows down page load). Show the default placeholder.
  return canonicalAvatarSrc(missingSrc);
}

const STANCE = {
  AGAINST: "against",
  NEUTRAL: "neutral",
  APPROVE: "approve",
};

function stanceColor(stance) {
  if (stance === STANCE.AGAINST) return "rgba(220, 38, 38, 0.9)";   // red
  if (stance === STANCE.APPROVE) return "rgba(34, 197, 94, 0.9)";   // green
  if (stance === STANCE.NEUTRAL) return "rgba(156, 163, 175, 0.9)"; // gray
  return null;
}

function stanceHeaderColor(stance) {
  if (stance === STANCE.AGAINST) return "#ef4444";
  if (stance === STANCE.APPROVE) return "#22c55e";
  if (stance === STANCE.NEUTRAL) return "#cbd5e1";
  return "#cbd5e1";
}

function getStanceForHandle(map, handle) {
  const h = String(handle ?? "").trim();
  if (!h || !map) return undefined;
  return map[h] ?? map[h.toLowerCase()];
}

function normalizedStance(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === STANCE.AGAINST) return STANCE.AGAINST;
  if (v === STANCE.NEUTRAL) return STANCE.NEUTRAL;
  if (v === "support" || v === STANCE.APPROVE) return STANCE.APPROVE;
  return STANCE.NEUTRAL;
}

function getNodeStance(node, labelsMap) {
  return normalizedStance(getStanceForHandle(labelsMap, node.handle) || node.seedStance);
}

function getAccountStanceValue(account, labelsMap) {
  const handle = normalizeHandle(account?.handle ?? account?.username ?? account?.screen_name);
  const override = getStanceForHandle(labelsMap, handle);
  return normalizedStance(override || account?.stance || account?.position || "neutral");
}

function hasAccountStance(account, labelsMap) {
  const handle = normalizeHandle(account?.handle ?? account?.username ?? account?.screen_name);
  const override = getStanceForHandle(labelsMap, handle);
  if (override) return true;
  const raw = String(account?.stance ?? account?.position ?? "").trim();
  return raw.length > 0;
}

const LABELS_STORAGE_KEY = "consensushealth:bip110:labels:v1";
const GLOW_CACHE_VERSION = 3;
const AVATAR_REV = "20260305d";
const DATA_REV = "20260305d";
const EQUAL_AVATAR_SIDE = 26;
const API_BASE = ((import.meta.env && import.meta.env.VITE_API_BASE) || "").replace(/\/$/, "");

function createStanceZoneSprite(color, radius, alpha) {
  const r = Math.max(12, Math.round(radius));
  const size = r * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return canvas;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`);
  grad.addColorStop(0.45, `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha * 0.4})`);
  grad.addColorStop(1, `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Region layout for the three stance clusters.
 *
 * Each cluster's half-width is estimated from the ACTUAL total avatar area it
 * holds (not a fraction of the screen width), because avatars are sized in
 * absolute pixels — on a narrow screen a fraction-of-width region is far smaller
 * than the cluster it must hold, so the large "against" cluster used to overflow
 * into the neutral zone.
 *
 * The three clusters are then placed left→right with EQUAL gaps between adjacent
 * edges and the whole group is centered. This keeps the neutral cluster in the
 * middle of the empty space between "against" and "approve" regardless of how
 * lopsided the counts are, and is screen-width independent (the fit step scales
 * it to the viewport), so phone and desktop stay consistent.
 */
function computeStanceRegions(nodes, labels, width) {
  if (!nodes || nodes.length === 0) return null;
  let redArea = 0, greyArea = 0, greenArea = 0;
  for (const d of nodes) {
    const stance = getNodeStance(d, labels);
    const side = Math.max(6, Number(d.side) || 12);
    const area = side * side;
    if (stance === STANCE.AGAINST) redArea += area;
    else if (stance === STANCE.APPROVE) greenArea += area;
    else greyArea += area; // neutral + unlabeled
  }

  const mid = width / 2;
  // Radius of a loosely packed blob whose members total `area` px² (random
  // circle packing ~0.62 density), i.e. cluster half-width in world px.
  const radiusOf = (area) => (area > 0 ? Math.sqrt(area / 0.62 / Math.PI) : 0);
  const rRed = radiusOf(redArea);
  const rGrey = radiusOf(greyArea);
  const rGreen = radiusOf(greenArea);

  const activeCount = Math.max(1, [rRed, rGrey, rGreen].filter((r) => r > 0).length);
  const avgRadius = (rRed + rGrey + rGreen) / activeCount;
  // Visible separation between adjacent clusters, scaled to cluster size.
  const gap = Math.max(Math.max(12, width * 0.012), avgRadius * 0.5);

  // Equal-gap, group-centered placement (derivation keeps both gaps == `gap`):
  //   against | gap | neutral | gap | approve
  const greyCx = mid + (rRed - rGreen);
  const redCx = greyCx - (rRed + gap + rGrey);
  const greenCx = greyCx + (rGrey + gap + rGreen);

  return {
    stanceCenterX: {
      [STANCE.AGAINST]: redCx,
      [STANCE.NEUTRAL]: greyCx,
      [STANCE.APPROVE]: greenCx,
    },
    redEnd: redCx + rRed,
    greyStart: greyCx - rGrey,
    greyEnd: greyCx + rGrey,
    greenStart: greenCx - rGreen,
    gapPx: gap,
    width,
  };
}

/** Soft bounds force: nudge vx so nodes stay in their stance region (k ~ 0.06). */
function forceStanceBounds(regionRef, labelsRef, k = 0.06) {
  let nodes;
  function force() {
    const r = regionRef.current;
    if (!r) return;
    for (const node of nodes) {
      const stance = getNodeStance(node, labelsRef.current);
      if (stance === STANCE.AGAINST && node.x > r.redEnd) {
        node.vx -= k * (node.x - r.redEnd);
      } else if (stance === STANCE.NEUTRAL) {
        if (node.x < r.greyStart) node.vx += k * (r.greyStart - node.x);
        else if (node.x > r.greyEnd) node.vx -= k * (node.x - r.greyEnd);
      } else if (stance === STANCE.APPROVE && node.x < r.greenStart) {
        node.vx += k * (r.greenStart - node.x);
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

/** Weak stance-center anchor: gently stabilizes each cluster's visual center without rigidizing packing. */
function forceStanceAnchor(regionRef, labelsRef, strength = 0.016) {
  let nodes;
  function force(alpha) {
    const r = regionRef.current;
    if (!r || !nodes) return;
    const k = Math.max(0, strength) * (alpha || 1);
    for (const node of nodes) {
      const stance = getNodeStance(node, labelsRef.current);
      const cx = r.stanceCenterX[stance] ?? (r.width || 0) / 2;
      node.vx += (cx - node.x) * k;
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

function normalizeIslandEdgeGaps(nodes, labelsMap, minGap = 18, blend = 0.45) {
  if (!Array.isArray(nodes) || nodes.length === 0) return;
  const bounds = {
    [STANCE.AGAINST]: { min: Infinity, max: -Infinity, count: 0 },
    [STANCE.NEUTRAL]: { min: Infinity, max: -Infinity, count: 0 },
    [STANCE.APPROVE]: { min: Infinity, max: -Infinity, count: 0 },
  };
  for (const n of nodes) {
    const stance = getNodeStance(n, labelsMap);
    const b = bounds[stance];
    if (!b) continue;
    const half = Number.isFinite(n?.half) ? n.half : Math.max(1, Number(n?.side || 0) / 2);
    const left = n.x - half;
    const right = n.x + half;
    if (left < b.min) b.min = left;
    if (right > b.max) b.max = right;
    b.count += 1;
  }
  if (!bounds.against.count || !bounds.neutral.count || !bounds.approve.count) return;

  const gapLeft = bounds.neutral.min - bounds.against.max;
  const gapRight = bounds.approve.min - bounds.neutral.max;
  const target = Math.max(minGap, (gapLeft + gapRight) / 2);
  let shiftAgainst = (gapLeft - target) * blend;
  let shiftApprove = (target - gapRight) * blend;
  const maxShift = Math.max(6, minGap * 0.85);
  shiftAgainst = clamp(shiftAgainst, -maxShift, maxShift);
  shiftApprove = clamp(shiftApprove, -maxShift, maxShift);

  if (Math.abs(shiftAgainst) < 0.05 && Math.abs(shiftApprove) < 0.05) return;

  for (const n of nodes) {
    const stance = getNodeStance(n, labelsMap);
    if (stance === STANCE.AGAINST) n.x += shiftAgainst;
    else if (stance === STANCE.APPROVE) n.x += shiftApprove;
  }
}

/**
 * "Equal avatar size" layout: pack every node into a screen-filling grid split
 * into three stance columns (against | neutral | approve). All avatars are the
 * same square size; a column's width is proportional to how many users it holds
 * (more users -> more sub-columns -> wider band). Positions are written in world
 * coordinates so the existing fit/zoom/pan pipeline scales the grid to fill the
 * viewport. Returns per-stance band-center x (world coords) for the ambient stance
 * zones, or null when there is nothing to lay out.
 */
function layoutEqualSizeGrid(nodes, labelsMap, w, h) {
  if (!nodes || nodes.length === 0 || w < 10 || h < 10) return null;
  const order = [STANCE.AGAINST, STANCE.NEUTRAL, STANCE.APPROVE];
  const groups = {
    [STANCE.AGAINST]: [],
    [STANCE.NEUTRAL]: [],
    [STANCE.APPROVE]: [],
  };
  for (const n of nodes) {
    const st = getNodeStance(n, labelsMap);
    (groups[st] || groups[STANCE.NEUTRAL]).push(n);
  }
  // Largest followers first within each column (stable, meaningful ordering).
  for (const key of order) groups[key].sort((a, b) => (b.followers || 0) - (a.followers || 0));

  const counts = order.map((k) => groups[k].length);
  const total = counts.reduce((a, c) => a + c, 0);
  if (total === 0) return null;

  const margin = Math.max(8, Math.min(w, h) * 0.02);
  const usableW = Math.max(20, w - margin * 2);
  const usableH = Math.max(20, h - margin * 2);
  const activeBands = counts.filter((c) => c > 0).length;
  const bandGutter = Math.max(6, usableW * 0.015);
  const gutterTotal = bandGutter * Math.max(0, activeBands - 1);
  const gridW = Math.max(10, usableW - gutterTotal);

  // Pick the row count that maximizes the uniform cell size while fitting every
  // avatar inside the usable area.
  let best = null;
  const maxRows = Math.min(total, 500);
  for (let R = 1; R <= maxRows; R++) {
    let totalCols = 0;
    for (const c of counts) if (c > 0) totalCols += Math.ceil(c / R);
    if (totalCols === 0) continue;
    const cell = Math.min(usableH / R, gridW / totalCols);
    if (!best || cell > best.cell) best = { R, totalCols, cell };
  }
  if (!best) return null;

  const { R, cell } = best;
  const colsPerBand = counts.map((c) => (c > 0 ? Math.ceil(c / R) : 0));
  const contentW = best.totalCols * cell + gutterTotal;
  const contentH = R * cell;
  const startX = (w - contentW) / 2;
  const startY = (h - contentH) / 2;
  const avatarSide = Math.max(6, cell * 0.9); // small uniform gap between avatars

  const regionCenters = {};
  let xCursor = startX;
  for (let gi = 0; gi < order.length; gi++) {
    const key = order[gi];
    const list = groups[key];
    const cols = colsPerBand[gi];
    if (cols === 0) {
      regionCenters[key] = xCursor;
      continue;
    }
    const bandW = cols * cell;
    regionCenters[key] = xCursor + bandW / 2;
    for (let i = 0; i < list.length; i++) {
      const col = Math.floor(i / R);
      const row = i % R;
      const n = list[i];
      n.x = xCursor + col * cell + cell / 2;
      n.y = startY + row * cell + cell / 2;
      n.vx = 0;
      n.vy = 0;
      n.side = avatarSide;
      n.half = avatarSide / 2;
    }
    xCursor += bandW + bandGutter;
  }
  return { stanceCenterX: regionCenters, gapPx: bandGutter };
}

// Persisted graph layout so a reload shows the settled positions instantly
// (no recompute, no fly-in animation). Keyed by a signature that captures
// everything the layout depends on: the exact node set + each node's stance and
// size, the viewport, and the layout-affecting modes.
const LAYOUT_CACHE_KEY = "consensushealth:layout:v2";

function computeLayoutSignature(nodes, labelsMap, w, h, plebsMode, equalAvatarSizeEnabled) {
  const parts = nodes
    .map((n) => `${normalizeHandle(n.handle)}:${getNodeStance(n, labelsMap)}:${Math.round(n.side)}`)
    .sort();
  const str = parts.join("|");
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return `${hash}|${nodes.length}|${Math.round(w)}x${Math.round(h)}|${plebsMode ? 1 : 0}|${equalAvatarSizeEnabled ? 1 : 0}`;
}

function loadLayoutPositions(signature) {
  try {
    const raw = localStorage.getItem(LAYOUT_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.sig !== signature || !obj.pos) return null;
    return obj.pos;
  } catch {
    return null;
  }
}

function saveLayoutPositions(signature, nodes) {
  try {
    const pos = {};
    for (const n of nodes) {
      const h = normalizeHandle(n.handle);
      if (h && Number.isFinite(n.x) && Number.isFinite(n.y)) {
        pos[h] = [Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100];
      }
    }
    localStorage.setItem(LAYOUT_CACHE_KEY, JSON.stringify({ sig: signature, pos, ts: Date.now() }));
  } catch {
    // storage full/unavailable: skip caching, layout still works
  }
}

function applyLayoutPositions(nodes, pos) {
  let applied = 0;
  for (const n of nodes) {
    const p = pos[normalizeHandle(n.handle)];
    if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      n.x = p[0];
      n.y = p[1];
      n.vx = 0;
      n.vy = 0;
      applied += 1;
    }
  }
  return applied;
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function createGlowSprite(aura, side, emphasize, quality = 1) {
  const fullLayers = emphasize
    ? [
        { blur: clamp(side * 1.9, 30, 220), alpha: 0.72, line: 2.8 },
        { blur: clamp(side * 3.8, 56, 420), alpha: 0.44, line: 3.8 },
        { blur: clamp(side * 5.9, 86, 620), alpha: 0.24, line: 4.8 },
        { blur: clamp(side * 8.4, 120, 900), alpha: 0.12, line: 5.8 },
      ]
    : [
        { blur: clamp(side * 1.6, 24, 180), alpha: 0.64, line: 2.4 },
        { blur: clamp(side * 3.2, 46, 360), alpha: 0.36, line: 3.4 },
        { blur: clamp(side * 5.2, 74, 560), alpha: 0.18, line: 4.4 },
        { blur: clamp(side * 7.4, 104, 820), alpha: 0.09, line: 5.4 },
      ];
  const layers = quality < 0.55 ? fullLayers.slice(0, 2) : fullLayers;
  // Prevent clipping: pad must account for the largest blur radius.
  const maxBlur = layers.reduce((m, l) => Math.max(m, l.blur * quality), 0);
  const padScale = 0.58 + quality * 0.42;
  const padBase = clamp(side * (emphasize ? 5.2 : 4.6) * padScale, 36, emphasize ? 360 : 300);
  const pad = Math.ceil(Math.max(padBase, maxBlur * 1.2));
  const size = Math.ceil(side + pad * 2);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return { canvas, pad };

  const x = pad;
  const y = pad;
  const r = Math.min(14, side * 0.22);

  g.save();
  g.globalCompositeOperation = "source-over";
  for (const layer of layers) {
    g.shadowColor = aura;
    g.shadowBlur = layer.blur * quality;
    g.strokeStyle = aura.replace(/[\d.]+\)$/, `${layer.alpha})`);
    g.lineWidth = layer.line;
    g.beginPath();
    drawRoundedRectPath(g, x, y, side, side, r);
    g.stroke();
  }
  g.shadowBlur = 0;
  g.restore();
  return { canvas, pad };
}

// Followers -> square side. 2k tiny, 50k medium, 500k+ big.
function sideFromFollowers(followers, minSide = 6, maxSide = 70) {
  const f = Math.max(0, followers);
  const x = Math.log10(f + 1);           // ~3 = 1k, ~4.7 = 50k, ~5.7 = 500k
  const t = (x - 3) / 3;                // 0 at ~1k, 1 at ~1M
  const tt = clamp(t, 0, 1);
  return minSide + tt * (maxSide - minSide);
}

function parseCsv(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: (err) => reject(err),
    });
  });
}

function getBase() {
  const raw = typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL;
  const base = (raw ?? "/").replace(/\/$/, "") || "";
  return base;
}

function missingAvatarSrcUrl() {
  const baseNoSlash = getBase().replace(/\/$/, "");
  return canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
}

/**
 * Read + clear the one-shot login-return snapshot written before a popup-blocked
 * OAuth redirect. Returns the restored dataset (to skip a graph refetch) or null.
 */
function consumeLoginReturnSnapshot() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(LOGIN_RETURN_KEY);
    if (raw) sessionStorage.removeItem(LOGIN_RETURN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object") return null;
    if (!Array.isArray(snap.accounts) || snap.accounts.length === 0) return null;
    if (typeof snap.ts !== "number" || Date.now() - snap.ts > LOGIN_RETURN_MAX_AGE_MS) return null;
    return {
      accounts: snap.accounts.filter((r) => (r?.handle ?? "").toString().trim().length > 0),
      selectedHandle: snap.selectedHandle ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Merge the current user's persisted stance row into the loaded accounts so their
 * node updates (or appears, for a first-time stance) without refetching the graph.
 */
function upsertSelfAccountLocally(prev, row) {
  if (!row || typeof row !== "object") return prev;
  const handleNorm = normalizeHandle(row.handle);
  const xId = String(row.x_user_id ?? "").trim();
  if (!handleNorm && !xId) return prev;
  const stance = normalizedStance(row.stance);
  let found = false;
  const next = prev.map((a) => {
    const ah = normalizeHandle(a?.handle);
    const ax = String(a?.x_user_id ?? "").trim();
    if ((handleNorm && ah === handleNorm) || (xId && ax && ax === xId)) {
      found = true;
      return { ...a, ...row, handle: ah || handleNorm, stance, position: stance };
    }
    return a;
  });
  if (found) return next;
  return [...next, { ...row, handle: handleNorm, x_user_id: xId, stance, position: stance }];
}

/** Load canonical seeded accounts + community accounts and merge by handle. */
async function loadAccounts() {
  const base = getBase();
  const [seededRes, community] = await Promise.all([
    fetch(`${base}/data/accounts_stanced.json?v=${DATA_REV}`),
    fetchCommunityUsers(),
  ]);
  const seeded = seededRes.ok ? await seededRes.json() : [];
  const isDevRuntime =
    (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") ||
    (typeof import.meta !== "undefined" && import.meta.env && !import.meta.env.PROD);
  const merged = [];
  const byHandle = new Map();
  const byXid = new Map();
  const richestByHandle = new Map();

  const upsert = (raw, source) => {
    const handleNorm = normalizeHandle(raw?.handle ?? raw?.username ?? raw?.screen_name);
    const xId = String(raw?.x_user_id ?? raw?.xUserId ?? raw?.id ?? "").trim();
    if (!handleNorm && !xId) return;

    const matchedBy = xId && byXid.get(xId) ? "x_user_id" : (handleNorm && byHandle.get(handleNorm) ? "handle" : "new");
    let rec = (xId && byXid.get(xId)) || (handleNorm && byHandle.get(handleNorm)) || null;
    if (!rec) {
      rec = { ...raw };
      merged.push(rec);
    }

    if (handleNorm) rec.handle = handleNorm;
    if (xId) rec.x_user_id = xId;

    const incomingName = String(raw?.name ?? "").trim();
    if (incomingName) {
      if (!rec.name || source === "seeded") rec.name = incomingName;
    }
    const incomingBio = String(raw?.bio ?? "").trim();
    if (incomingBio) {
      const currentBio = String(rec?.bio ?? "").trim();
      if (!currentBio || source === "community") rec.bio = incomingBio;
    }
    const incomingAccountCreatedAt = normalizeAccountCreatedAt(
      raw?.accountCreatedAt ?? raw?.account_created_at
    );
    if (incomingAccountCreatedAt) {
      const currentAccountCreatedAt = normalizeAccountCreatedAt(
        rec?.accountCreatedAt ?? rec?.account_created_at
      );
      if (!currentAccountCreatedAt || source === "community") {
        rec.accountCreatedAt = incomingAccountCreatedAt;
      }
    }

    // Prefer any non-empty avatar value across known profile fields.
    const avatarCandidate = firstNonEmptyAvatarField(raw);
    if (avatarCandidate) {
      rec.avatar_url = avatarCandidate;
    } else if (!rec.avatar_url) {
      const existingCandidate = firstNonEmptyAvatarField(rec);
      if (existingCandidate) rec.avatar_url = existingCandidate;
    }

    const followers = toFiniteNumber(raw?.followers_count);
    const currentFollowers = toFiniteNumber(rec?.followers_count);
    if (followers != null) {
      const safeFollowers = Math.max(0, followers);
      if (source === "seeded") {
        rec.followers_count = safeFollowers;
      } else if (safeFollowers > 0 || currentFollowers == null || currentFollowers <= 0) {
        // Avoid letting minimal stance rows (0/null followers) clobber richer profile records.
        rec.followers_count = safeFollowers;
      }
    }
    if (source === "community") rec.stance = normalizedStance(raw?.stance ?? rec?.stance);
    else if (rec.stance) rec.stance = normalizedStance(rec.stance);
    if (source === "community") {
      const hasUserStanceChange = Boolean(raw?.hasUserStanceChange ?? raw?.has_user_stance_change);
      if (hasUserStanceChange) rec.hasUserStanceChange = true;
      else if (typeof rec.hasUserStanceChange !== "boolean") rec.hasUserStanceChange = false;
    }

    if (handleNorm) {
      const prevRich = richestByHandle.get(handleNorm);
      const recFollowers = toFiniteNumber(rec?.followers_count) ?? 0;
      const prevFollowers = toFiniteNumber(prevRich?.followers_count) ?? 0;
      if (!prevRich || recFollowers > prevFollowers) {
        richestByHandle.set(handleNorm, {
          followers_count: recFollowers,
          avatar_url: firstNonEmptyAvatarField(rec) || rec.avatar_url || null,
          name: String(rec?.name ?? "").trim() || null,
        });
      }
    }

    if (isDevRuntime && source === "community") {
      const avatarFields = collectAvatarFieldValues(raw);
      const resolvedAvatar = firstNonEmptyAvatarField(raw) || firstNonEmptyAvatarField(rec) || "";
      console.log("[auth-merge]", {
        x_user_id: xId || null,
        handle: handleNorm || null,
        matchedBy,
        stance: rec.stance || null,
        avatarFieldsReceived: avatarFields,
        avatarPersistedForMerge: rec.avatar_url || null,
        resolvedAvatar,
      });
    }

    if (xId) byXid.set(xId, rec);
    if (handleNorm) byHandle.set(handleNorm, rec);
  };

  for (const a of Array.isArray(seeded) ? seeded : []) upsert(a, "seeded");
  for (const c of Array.isArray(community) ? community : []) upsert(c, "community");

  for (const rec of merged) {
    if (!rec.handle) continue;
    const handleNorm = normalizeHandle(rec.handle);
    const rich = richestByHandle.get(handleNorm);
    const currentFollowers = toFiniteNumber(rec.followers_count);
    if ((currentFollowers == null || currentFollowers <= 0) && rich?.followers_count > 0) {
      rec.followers_count = rich.followers_count;
      if (!rec.avatar_url && rich.avatar_url) rec.avatar_url = rich.avatar_url;
      if (!rec.name && rich.name) rec.name = rich.name;
      if (isDevRuntime && rec.stance) {
        console.log("[auth-merge][repair-backfill]", {
          handle: handleNorm,
          restoredFollowers: rich.followers_count,
          restoredAvatar: Boolean(rich.avatar_url),
          restoredName: Boolean(rich.name),
          reason: "Community stance row had missing/zero profile fields",
        });
      }
    }
    if (rec.followers_count == null || !Number.isFinite(Number(rec.followers_count))) {
      rec.followers_count = 0;
    } else {
      rec.followers_count = Math.max(0, toInt(rec.followers_count));
    }
    rec.avatar_url = firstNonEmptyAvatarField(rec) || rec.avatar_url || null;
    rec.bio = String(rec.bio ?? "").trim() || null;
    rec.accountCreatedAt = normalizeAccountCreatedAt(
      rec.accountCreatedAt ?? rec.account_created_at
    );
    rec.hasUserStanceChange = Boolean(rec.hasUserStanceChange);
    if (isDevRuntime && rec.stance && !rec.avatar_path && !rec.avatar_url) {
      console.log("[auth-merge][missing-avatar-after-merge]", {
        handle: normalizeHandle(rec.handle),
        x_user_id: String(rec.x_user_id ?? ""),
        stance: rec.stance,
        reason: "No avatar field available after merge",
      });
    }
  }

  console.log("[ConsensusHealth] loaded seeded:", Array.isArray(seeded) ? seeded.length : 0, "community:", community.length, "merged:", merged.length);
  return merged;
}

function useContainerSize(containerRef) {
  const [size, setSize] = useState(() => {
    if (typeof window === "undefined") return { w: 800, h: 600 };
    return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight - 56) };
  });
  useEffect(() => {
    const el = containerRef.current;
    const fromContainer = () => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w > 100 && h > 100) setSize((prev) => (prev.w !== w || prev.h !== h ? { w, h } : prev));
    };
    const fromWindow = () => {
      setSize({ w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight - 56) });
    };
    fromContainer();
    requestAnimationFrame(() => {
      requestAnimationFrame(fromContainer);
    });
    const t = setTimeout(fromWindow, 150);
    const ro = el ? new ResizeObserver(fromContainer) : null;
    if (el) ro.observe(el);
    window.addEventListener("resize", fromWindow);
    return () => {
      clearTimeout(t);
      ro?.disconnect();
      window.removeEventListener("resize", fromWindow);
    };
  }, [containerRef]);
  return size;
}

export default function App() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const { w, h } = useContainerSize(containerRef);
  const isFirefox = useMemo(
    () => typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent || ""),
    []
  );

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [accounts, setAccounts] = useState([]); // [{handle, followers_count, seed_follow_count, ...}]
  const [mentions, setMentions] = useState([]); // tweet rows
  const [selectedHandle, setSelectedHandle] = useState(null);
  const [search, setSearch] = useState("");
  const [me, setMe] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  // OAuth popup bookkeeping. beginLogin opens a popup and we complete login by
  // re-reading /api/me (no full-page reload / graph refetch). Refs avoid stale
  // closures inside the message/poll handlers.
  const authPopupRef = useRef(null);
  const authPollRef = useRef(0);
  const authInFlightRef = useRef(false);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [statsData, setStatsData] = useState(null);
  const statsDataRef = useRef(null);
  const statsFetchStartedAtRef = useRef(0);
  const [showDonateModal, setShowDonateModal] = useState(false);
  const [adminOptionsOpen, setAdminOptionsOpen] = useState(false);
  // Avatar profile dropdown (holds Log out), toggled by clicking the avatar.
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  // Transient "just selected" marker (ui stance key) that drives the stance
  // segmented control's brief pop animation; cleared shortly after selection.
  const [stancePop, setStancePop] = useState(null);
  const stancePopTimerRef = useRef(0);
  /** Three scrollable stance columns (avatars + names) instead of force graph; mutually exclusive with Plebs / equal size / manual edit. */
  const [stanceListsViewEnabled, setStanceListsViewEnabled] = useState(false);
  const [plebsMode, setPlebsMode] = useState(false);
  const [influencersMode, setInfluencersMode] = useState(false);
  const [equalAvatarSizeEnabled, setEqualAvatarSizeEnabled] = useState(false);
  const [dimOthersEnabled, setDimOthersEnabled] = useState(false);
  const [historyPlaybackPlaying, setHistoryPlaybackPlaying] = useState(false);
  const [historyPlaybackHasFinishedOnce, setHistoryPlaybackHasFinishedOnce] = useState(false);
  /** Server-reported stance playback rows; null = not loaded (non-admin or not fetched). */
  const [stancePlaybackSequenceCount, setStancePlaybackSequenceCount] = useState(null);
  const [pulseSelectedEnabled, setPulseSelectedEnabled] = useState(false);
  const [manualEditMode, setManualEditMode] = useState(false);
  const [manualEditTarget, setManualEditTarget] = useState(null);
  const [manualEditChoice, setManualEditChoice] = useState("neutral");
  const [manualEditBusy, setManualEditBusy] = useState(false);
  const [manualEditError, setManualEditError] = useState("");
  const [labels, setLabels] = useState(() => ({}));
  const [dropdownHoverHandle, setDropdownHoverHandle] = useState(null);
  const adminOptionsRef = useRef(null);
  const profileMenuRef = useRef(null);
  const stancePlaybackItemsRef = useRef(null);
  const mentionsRequestedRef = useRef(false);
  const historyPlaybackRef = useRef({
    active: false,
    sequence: [],
    played: new Set(),
    index: 0,
    phase: "idle",
    phaseStart: 0,
    holdMs: 100,
    moveMs: 280,
    gapMs: 20,
    rafId: 0,
    currentHandle: null,
  });
  const newStancesIntroRef = useRef({
    active: false,
    startedAt: 0,
    items: [],
    hiddenIds: new Set(),
    hiddenHandles: new Set(),
    landedIds: new Set(),
    landedHandles: new Set(),
    reducedMotion: false,
    rafId: 0,
    batchId: "",
    markerEvents: [],
    phase: "idle",
  });
  const meRef = useRef(null);
  const [newStancesUi, setNewStancesUi] = useState({ headingOpacity: 0, debug: false, bandActive: false });
  const headerRef = useRef(null);
  const [headerHeightPx, setHeaderHeightPx] = useState(56);

  useEffect(() => {
    meRef.current = me;
  }, [me]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => {
      const next = Math.max(1, Math.round(el.getBoundingClientRect().height));
      setHeaderHeightPx((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [loading, err]);

  useEffect(() => {
    try {
      localStorage.removeItem(LABELS_STORAGE_KEY);
    } catch {
      // ignore storage failures
    }
  }, []);

  async function loadMe() {
    try {
      const res = await fetch(`${API_BASE}/api/me`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const authenticated = Boolean(data && data.x_user_id);
      setMe(authenticated ? { authenticated: true, ...data } : { authenticated: false });
      setEqualAvatarSizeEnabled(authenticated ? Boolean(data?.equal_avatar_size) : false);
      if (authenticated && data?.handle && data?.stance) {
        setLabels((prev) => ({ ...prev, [String(data.handle).toLowerCase()]: normalizedStance(data.stance) }));
      }
    } catch {
      // ignore auth failures in local dev
    }
  }

  // Persist a lightweight snapshot so the popup-blocked redirect fallback can
  // restore the graph after the callback WITHOUT refetching the dataset.
  function saveLoginReturnSnapshot() {
    try {
      if (!accounts.length) return;
      const snap = {
        ts: Date.now(),
        accounts,
        selectedHandle: selectedHandle ?? null,
      };
      sessionStorage.setItem(LOGIN_RETURN_KEY, JSON.stringify(snap));
    } catch {
      // Quota / serialization / disabled storage: fall back to a normal reload.
    }
  }

  function stopAuthPopupWatch() {
    if (authPollRef.current) {
      clearInterval(authPollRef.current);
      authPollRef.current = 0;
    }
  }

  // Finish a popup login: refresh ONLY the session/user, never the graph.
  async function completeLogin() {
    if (!authInFlightRef.current) return;
    authInFlightRef.current = false;
    stopAuthPopupWatch();
    try {
      const popup = authPopupRef.current;
      if (popup && !popup.closed) popup.close();
    } catch {
      // ignore cross-origin close errors
    }
    authPopupRef.current = null;
    await loadMe();
    setAuthBusy(false);
  }

  function beginLogin() {
    if (authInFlightRef.current) return;
    let popup = null;
    try {
      popup = window.open("/auth/x/login?mode=popup", "consensushealth_oauth", buildPopupFeatures(window));
    } catch {
      popup = null;
    }
    if (!popup) {
      // Popup blocked: preserve state and fall back to a normal full-page redirect.
      saveLoginReturnSnapshot();
      window.location.assign("/auth/x/login");
      return;
    }
    authInFlightRef.current = true;
    authPopupRef.current = popup;
    setAuthBusy(true);
    // Robust completion signal: the popup self-closes when auth finishes, at which
    // point we re-read the session. Works even if postMessage is missed.
    stopAuthPopupWatch();
    const startedAt = Date.now();
    authPollRef.current = window.setInterval(() => {
      let closed = false;
      try {
        closed = !authPopupRef.current || authPopupRef.current.closed;
      } catch {
        closed = false;
      }
      if (closed) {
        void completeLogin();
        return;
      }
      // Safety valve: stop watching after 5 minutes if nothing happened.
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        stopAuthPopupWatch();
        authInFlightRef.current = false;
        authPopupRef.current = null;
        setAuthBusy(false);
      }
    }, 500);
  }

  async function logout() {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setMe(null);
      setEqualAvatarSizeEnabled(false);
    }
  }

  async function setMyStance(stance) {
    if (!me?.authenticated) return;
    try {
      setAuthBusy(true);
      const res = await fetch(`${API_BASE}/api/stance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stance }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.handle && data?.stance) {
        setLabels((prev) => ({ ...prev, [String(data.handle).toLowerCase()]: normalizedStance(data.stance) }));
        // Update only this user's node locally; never reload or refetch the graph.
        setAccounts((prev) => upsertSelfAccountLocally(prev, data));
      }
      await loadMe();
    } finally {
      setAuthBusy(false);
    }
  }

  // Wrapper for the toolbar stance buttons: triggers the brief selection pop
  // (CSS-gated by prefers-reduced-motion) and then applies the stance.
  function selectStance(uiStance, apiStance) {
    setStancePop(uiStance);
    if (stancePopTimerRef.current) clearTimeout(stancePopTimerRef.current);
    stancePopTimerRef.current = setTimeout(() => setStancePop(null), 240);
    setMyStance(apiStance);
  }

  useEffect(() => () => {
    if (stancePopTimerRef.current) clearTimeout(stancePopTimerRef.current);
  }, []);

  async function setEqualAvatarSizePreference(nextValue) {
    setEqualAvatarSizeEnabled(Boolean(nextValue));
    if (!me?.authenticated) return;
    try {
      await fetch(`${API_BASE}/api/me/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ equal_avatar_size: Boolean(nextValue) }),
      });
    } catch {
      // ignore transient preference save failures; UI remains responsive
    }
  }

  useEffect(() => {
    statsDataRef.current = statsData;
  }, [statsData]);

  async function fetchStats({ forceLoading = false, cancelled } = {}) {
    const isCancelled = () => (typeof cancelled === "function" ? cancelled() : false);
    const mountToStartMs = statsFetchStartedAtRef.current
      ? Math.round(performance.now() - statsFetchStartedAtRef.current)
      : null;
    const requestStarted = performance.now();
    try {
      if (forceLoading || !statsDataRef.current) setStatsLoading(true);
      setStatsError("");
      const res = await fetch(`${API_BASE}/api/stats`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
      const data = await res.json();
      if (isCancelled()) return;
      setStatsData(data);
      if (!(typeof import.meta !== "undefined" && import.meta.env && import.meta.env.PROD)) {
        // eslint-disable-next-line no-console
        console.log("[stats] timing", {
          mount_to_request_start_ms: mountToStartMs,
          frontend_request_ms: Math.round(performance.now() - requestStarted),
          server_timing_ms: data?._timing?.total_ms ?? null,
          server_db_ms: data?._timing?.db_ms ?? null,
          server_cache_hit: Boolean(data?._timing?.cache_hit),
        });
      }
    } catch (e) {
      if (isCancelled()) return;
      setStatsError(String(e?.message || e));
    } finally {
      if (!isCancelled()) setStatsLoading(false);
    }
  }

  useEffect(() => {
    if (!showStatsModal) return;
    let dead = false;
    fetchStats({
      forceLoading: !statsDataRef.current,
      cancelled: () => dead,
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showStatsModal]);

  function openStatsModal() {
    statsFetchStartedAtRef.current = performance.now();
    setStatsError("");
    // Set loading before paint so Stance history never flashes fake zeros.
    if (!statsDataRef.current) setStatsLoading(true);
    setShowStatsModal(true);
  }

  useEffect(() => {
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fast path for popup login completion: the popup notifies us via postMessage
  // and BroadcastChannel. Either one triggers a session-only refresh (no reload).
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      if (!isAuthResultMessage(event.data)) return;
      if (isAuthSuccessMessage(event.data)) void completeLogin();
      else {
        // Auth failed in the popup: stop the spinner without touching the graph.
        stopAuthPopupWatch();
        authInFlightRef.current = false;
        authPopupRef.current = null;
        setAuthBusy(false);
      }
    };
    let channel = null;
    try {
      channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
      channel.onmessage = (event) => {
        if (isAuthSuccessMessage(event.data)) void completeLogin();
      };
    } catch {
      channel = null;
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      stopAuthPopupWatch();
      try {
        if (channel) channel.close();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meStance = me?.stance ? normalizedStance(me.stance) : "";
  const meHandleLower = safeLower(me?.handle);
  const isPrivilegedEditor = useMemo(() => isPrivilegedManualEditor(me?.handle), [me?.handle]);

  useEffect(() => {
    if (!API_BASE) {
      stancePlaybackItemsRef.current = [];
      setStancePlaybackSequenceCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/stance-playback-sequence`, { credentials: "include" });
        if (cancelled) return;
        if (!res.ok) {
          stancePlaybackItemsRef.current = [];
          setStancePlaybackSequenceCount(0);
          return;
        }
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : [];
        stancePlaybackItemsRef.current = items;
        setStancePlaybackSequenceCount(items.length);
      } catch {
        if (!cancelled) {
          stancePlaybackItemsRef.current = [];
          setStancePlaybackSequenceCount(0);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      const pb = historyPlaybackRef.current;
      if (pb.rafId) cancelAnimationFrame(pb.rafId);
      pb.rafId = 0;
      pb.active = false;
    },
    []
  );

  const visibleAccounts = useMemo(() => {
    if (plebsMode) {
      return accounts.filter((a) => {
        const info = getFollowersFromUser(a);
        return info.source !== "none" && info.followers < 3000;
      });
    }
    if (influencersMode) {
      return accounts.filter((a) => {
        const info = getFollowersFromUser(a);
        return info.source !== "none" && info.followers >= 3000;
      });
    }
    return accounts;
  }, [accounts, plebsMode, influencersMode]);

  // A follower-filtered subset is active; dataset-wide change stats don't match it.
  const followerFilterActive = plebsMode || influencersMode;

  const accountByHandle = useMemo(() => {
    const m = new Map();
    for (const a of visibleAccounts) {
      const h = normalizeHandle(a?.handle);
      if (!h) continue;
      m.set(h, a);
    }
    return m;
  }, [visibleAccounts]);
  const pillActiveStyle = (stance) => {
    if (stance === "against") {
      return {
        borderColor: "rgba(220,38,38,0.9)",
        opacity: 1,
        background: "rgba(220,38,38,0.18)",
        boxShadow: "0 0 0 1px rgba(220,38,38,0.34), 0 0 16px rgba(220,38,38,0.52), 0 0 26px rgba(220,38,38,0.34)",
      };
    }
    if (stance === "neutral") {
      return {
        borderColor: "rgba(156,163,175,0.9)",
        opacity: 1,
        background: "rgba(156,163,175,0.18)",
        boxShadow: "0 0 0 1px rgba(156,163,175,0.32), 0 0 16px rgba(156,163,175,0.44), 0 0 24px rgba(156,163,175,0.28)",
      };
    }
    return {
      borderColor: "rgba(34,197,94,0.9)",
      opacity: 1,
      background: "rgba(34,197,94,0.18)",
      boxShadow: "0 0 0 1px rgba(34,197,94,0.34), 0 0 16px rgba(34,197,94,0.52), 0 0 26px rgba(34,197,94,0.34)",
    };
  };
  const donateAvatarSrc = useMemo(() => {
    const baseNoSlash = getBase().replace(/\/$/, "");
    const account = accounts.find((a) => safeLower(a.handle) === "zndtoshi");
    if (account?.avatar_path) return canonicalAvatarSrc(`${baseNoSlash}${account.avatar_path}?v=${AVATAR_REV}`);
    if (account?.avatar_url) {
      return canonicalAvatarSrc(maybeProxyAvatarUrl(normalizeTwitterAvatarUrl(account.avatar_url)));
    }
    return canonicalAvatarSrc(`${baseNoSlash}/avatars/zndtoshi.jpg?v=${AVATAR_REV}`);
  }, [accounts]);
  const meChipAvatarSrc = useMemo(() => {
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missing = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    const raw = String(me?.avatar_url ?? "").trim();
    if (!raw) return missing;
    return canonicalAvatarSrc(maybeProxyAvatarUrl(normalizeTwitterAvatarUrl(raw))) || missing;
  }, [me?.avatar_url]);
  const selectedHeaderAvatarSrc = useMemo(() => {
    if (!selectedHandle) return "";
    const key = normalizeHandle(selectedHandle);
    const account = accountByHandle.get(key) || null;
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    return resolveAvatarUrlForAccount(account || { handle: key }, baseNoSlash, missingSrc);
  }, [selectedHandle, accountByHandle]);
  const selectedHeaderStance = useMemo(() => {
    if (!selectedHandle) return "";
    const key = normalizeHandle(selectedHandle);
    const account = accountByHandle.get(key) || null;
    return getAccountStanceValue(account || { handle: key }, labels);
  }, [selectedHandle, accountByHandle, labels]);
  const donationAddress = String(me?.donation_btc_address || "bc1qxum7h6z90ynk889j0vr9j7pasqxj9f7qgeqxq7").trim();
  const statisticsData = useMemo(() => {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const flowNorm = (s) => {
      const v = String(s ?? "").toLowerCase();
      if (v === "against" || v === "neutral" || v === "approve") return v;
      if (v === "support") return "approve";
      return null;
    };

    const canonicalById = new Map();
    const canonicalByHandle = new Map();

    for (const a of visibleAccounts) {
      const handle =
        normalizeHandle(a?.handle) ||
        normalizeHandle(a?.username) ||
        normalizeHandle(a?.screen_name);
      const xId = String(a?.x_user_id ?? a?.xUserId ?? "").trim();
      const stance = getAccountStanceValue(a, labels);
      const followersInfo = getFollowersFromUser(a);
      const candidate = {
        raw: a,
        handle,
        xId: xId || null,
        stance,
        followers: followersInfo.followers,
        followersSource: followersInfo.source,
      };

      let existing = null;
      if (candidate.xId && canonicalById.has(candidate.xId)) existing = canonicalById.get(candidate.xId);
      else if (candidate.handle && canonicalByHandle.has(candidate.handle)) existing = canonicalByHandle.get(candidate.handle);

      if (existing) {
        const sourceRank = (src) => (src === "profile" || src === "twitterProfile" ? 3 : src === "followers_count" ? 2 : 0);
        const shouldReplaceFollowers =
          sourceRank(candidate.followersSource) > sourceRank(existing.followersSource) ||
          (sourceRank(candidate.followersSource) === sourceRank(existing.followersSource) && candidate.followers > existing.followers);

        if (shouldReplaceFollowers) {
          existing.followers = candidate.followers;
          existing.followersSource = candidate.followersSource;
          existing.raw = candidate.raw;
        }
        if (candidate.stance) existing.stance = candidate.stance;
        if (!existing.handle && candidate.handle) existing.handle = candidate.handle;
        if (!existing.xId && candidate.xId) existing.xId = candidate.xId;
      } else {
        existing = candidate;
      }

      if (existing.xId) canonicalById.set(existing.xId, existing);
      if (existing.handle) canonicalByHandle.set(existing.handle, existing);
    }

    const uniqueUsers = new Set([...canonicalById.values(), ...canonicalByHandle.values()]);
    const rows = [...uniqueUsers];

    const counts = { against: 0, neutral: 0, approve: 0 };
    const followersTotal = { against: 0, neutral: 0, approve: 0 };
    const topAccountByFollowers = { against: null, neutral: null, approve: null };
    for (const u of rows) {
      const stance = u.stance;
      if (!(stance === "against" || stance === "neutral" || stance === "approve")) continue;
      counts[stance] += 1;
      followersTotal[stance] += u.followers;
      const prevTop = topAccountByFollowers[stance];
      if (!prevTop || u.followers > prevTop.followers) {
        topAccountByFollowers[stance] = {
          handle: u.handle || "(unknown)",
          followers: u.followers,
        };
      }
    }
    const totalUsersWithStance = counts.against + counts.neutral + counts.approve;
    const denom = totalUsersWithStance || 1;
    const percentages = {
      against: Math.round((counts.against / denom) * 1000) / 10,
      neutral: Math.round((counts.neutral / denom) * 1000) / 10,
      approve: Math.round((counts.approve / denom) * 1000) / 10,
    };
    const avgFollowersByStance = {
      against: counts.against ? Math.round(followersTotal.against / counts.against) : 0,
      neutral: counts.neutral ? Math.round(followersTotal.neutral / counts.neutral) : 0,
      approve: counts.approve ? Math.round(followersTotal.approve / counts.approve) : 0,
    };

    const adam = rows.find((u) => normalizeHandle(u.handle) === "adam3us");
    const isProd =
      (typeof process !== "undefined" &&
        process.env &&
        process.env.NODE_ENV === "production") ||
      (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.PROD);
    if (!isProd && adam) {
      // eslint-disable-next-line no-console
      console.log("[stats] adam3us", { stance: adam.stance, followers: adam.followers, raw: adam.raw });
    }

    return {
      totalUsersWithStance,
      counts,
      percentages,
      totalFollowersByStance: followersTotal,
      avgFollowersByStance,
      topAccountByFollowers,
      usersChangedStanceAtLeastOnce: followerFilterActive ? 0 : num(statsData?.changed_ever),
      totalStanceChangesLast7Days: followerFilterActive ? 0 : num(statsData?.changes_last_7d),
      totalStanceChanges: followerFilterActive ? 0 : num(statsData?.total_changes),
      transitionCounts: !followerFilterActive && Array.isArray(statsData?.transition_counts)
        ? statsData.transition_counts
            .map((f) => ({
              from: flowNorm(f.from),
              to: flowNorm(f.to),
              count: num(f.count),
            }))
            .filter((f) => (f.from === null || f.from) && (f.to === "against" || f.to === "neutral" || f.to === "approve"))
        : [],
      recentChanges: !followerFilterActive && Array.isArray(statsData?.recent_changes)
        ? statsData.recent_changes
            .map((r) => ({
              id: Number(r.id) || 0,
              handle: String(r.handle ?? "").trim().replace(/^@+/, "") || "(unknown)",
              display_name: r.display_name != null && String(r.display_name).trim() ? String(r.display_name) : null,
              followers_count:
                r.followers_count == null || r.followers_count === ""
                  ? null
                  : Number.isFinite(Number(r.followers_count))
                    ? Math.trunc(Number(r.followers_count))
                    : null,
              from: flowNorm(r.from ?? r.previous_stance),
              to: flowNorm(r.to ?? r.new_stance) || "neutral",
              changed_at: String(r.changed_at || ""),
              changed_by: String(r.changed_by || "").trim() || null,
            }))
            .filter((r) => r.to === "against" || r.to === "neutral" || r.to === "approve")
        : [],
      recentChangesNextCursor: !followerFilterActive && statsData?.recent_changes_next_cursor
        ? String(statsData.recent_changes_next_cursor)
        : null,
      recentChangesHasMore: !followerFilterActive && Boolean(statsData?.recent_changes_has_more),
      historyStatus: followerFilterActive
        ? "loaded"
        : statsData
          ? "loaded"
          : statsError
            ? "error"
            : "loading",
      historyError: statsError ? String(statsError) : null,
      topFlowsLast7Days: !followerFilterActive && Array.isArray(statsData?.flows_last_7d)
        ? statsData.flows_last_7d
            .map((f) => ({
              from: flowNorm(f.from),
              to: flowNorm(f.to),
              count: num(f.count),
            }))
            .filter((f) => (f.from === null || f.from) && (f.to === "against" || f.to === "neutral" || f.to === "approve"))
        : [],
      generatedAtISO: String(statsData?.generated_at || new Date().toISOString()),
    };
  }, [statsData, visibleAccounts, labels, followerFilterActive, statsError]);

  async function refreshStatsNow() {
    await fetchStats({ forceLoading: false });
  }

  async function saveManualStanceEdit() {
    if (!isPrivilegedEditor || !manualEditTarget || manualEditBusy) return;
    setManualEditBusy(true);
    setManualEditError("");
    try {
      const res = await fetch(`${API_BASE}/api/admin/stance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          handle: manualEditTarget.handle,
          x_user_id: manualEditTarget.x_user_id || null,
          stance: manualEditChoice,
        }),
      });
      if (!res.ok) {
        let msg = `Failed (${res.status})`;
        try {
          const errData = await res.json();
          if (errData?.error) msg = String(errData.error);
        } catch {
          // ignore parse errors
        }
        throw new Error(msg);
      }
      const data = await res.json();
      const targetHandleNorm = normalizeHandle(data?.handle || manualEditTarget.handle);
      const next = normalizedStance(data?.stance || manualEditChoice);
      setLabels((prev) => ({ ...prev, [targetHandleNorm]: next }));
      setAccounts((prev) => applyManualStanceUpdate(prev, targetHandleNorm, next));
      await refreshStatsNow();
      setManualEditTarget(null);
      if (!import.meta.env.PROD) {
        // eslint-disable-next-line no-console
        console.log("[manual-edit] saved", {
          target: targetHandleNorm,
          nextStance: next,
        });
      }
    } catch (e) {
      const msg = String(e?.message || e);
      setManualEditError(msg);
      if (!import.meta.env.PROD) {
        // eslint-disable-next-line no-console
        console.warn("[manual-edit] failed", {
          target: manualEditTarget?.handle || null,
          stance: manualEditChoice,
          error: msg,
        });
      }
    } finally {
      setManualEditBusy(false);
    }
  }

  useEffect(() => {
    if (isPrivilegedEditor) return;
    setManualEditMode(false);
    setManualEditTarget(null);
    setManualEditChoice("neutral");
    setManualEditError("");
  }, [isPrivilegedEditor]);

  useEffect(() => {
    if (manualEditMode) return;
    setManualEditTarget(null);
    setManualEditChoice("neutral");
    setManualEditError("");
  }, [manualEditMode]);

  useEffect(() => {
    if (!adminOptionsOpen) return;
    const onDocMouseDown = (e) => {
      const root = adminOptionsRef.current;
      if (!root) return;
      if (root.contains(e.target)) return;
      setAdminOptionsOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [adminOptionsOpen]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const onDocMouseDown = (e) => {
      const root = profileMenuRef.current;
      if (!root) return;
      if (root.contains(e.target)) return;
      setProfileMenuOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setProfileMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (!selectedHandle) return;
    const selectedNorm = normalizeHandle(selectedHandle);
    const visible = visibleAccounts.some((a) => normalizeHandle(a.handle) === selectedNorm);
    if (!visible) setSelectedHandle(null);
  }, [visibleAccounts, selectedHandle]);

  useEffect(() => {
    if (!manualEditTarget) return;
    const targetNorm = normalizeHandle(manualEditTarget.handle);
    const visible = visibleAccounts.some((a) => normalizeHandle(a.handle) === targetNorm);
    if (!visible) setManualEditTarget(null);
  }, [visibleAccounts, manualEditTarget]);

  useEffect(() => {
    if (!pulseSelectedEnabled || !selectedHandle) return;
    let raf = 0;
    const tick = () => {
      drawRef.current();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [pulseSelectedEnabled, selectedHandle]);

  // Load canonical accounts from public/data at mount (needed to render the graph).
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        setLoading(true);
        setErr("");
        // Popup-blocked login fallback: if we just came back from a full-page
        // OAuth redirect, restore the previously loaded dataset instead of
        // refetching the whole graph.
        const restored = consumeLoginReturnSnapshot();
        if (restored) {
          if (dead) return;
          setAccounts(restored.accounts);
          if (restored.selectedHandle) setSelectedHandle(restored.selectedHandle);
          return;
        }
        const cleanedAccounts = await loadAccounts();
        if (dead) return;
        const accountsFiltered = cleanedAccounts.filter((r) => (r.handle ?? "").toString().trim().length > 0);
        setAccounts(accountsFiltered);
      } catch (e) {
        if (!dead) setErr(String(e?.message || e));
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  // Defer the mentions CSV (462 KB) + PapaParse: it is only needed to show a
  // selected user's tweets, not for first paint. Dynamically import PapaParse so
  // it stays out of the initial bundle, and fetch/parse on idle (or immediately
  // once a handle is selected). Runs at most once.
  useEffect(() => {
    if (mentionsRequestedRef.current) return;
    if (!accounts.length && !selectedHandle) return;
    let cancelled = false;

    const run = async () => {
      if (mentionsRequestedRef.current || cancelled) return;
      mentionsRequestedRef.current = true;
      try {
        const base = getBase();
        const text = await fetch(`${base}/data/mentions_bip110.csv?v=${DATA_REV}`).then((r) =>
          r.ok ? r.text() : ""
        );
        if (cancelled) return;
        if (!text) {
          mentionsRequestedRef.current = false;
          return;
        }
        const { default: Papa } = await import("papaparse");
        const parsed = await new Promise((resolve, reject) => {
          Papa.parse(text, {
            header: true,
            skipEmptyLines: true,
            complete: (res) => resolve(res.data || []),
            error: (err) => reject(err),
          });
        });
        if (cancelled) return;
        const cleanedMentions = parsed
          .map((r) => ({
            handle: (r.handle ?? "").trim().toLowerCase(),
            tweet_id: (r.tweet_id ?? "").trim(),
            created_at: (r.created_at ?? "").trim(),
            tweet_url: (r.tweet_url ?? "").trim(),
            text_snippet: (r.text_snippet ?? "").trim(),
          }))
          .filter((r) => r.handle.length > 0 && (r.tweet_url.length > 0 || r.tweet_id.length > 0));
        setMentions(cleanedMentions);
      } catch {
        // Allow a later retry (e.g. on selection) if the deferred load failed.
        mentionsRequestedRef.current = false;
      }
    };

    let idleId = 0;
    let timeoutId = 0;
    const hasIdle = typeof window !== "undefined" && "requestIdleCallback" in window;
    if (selectedHandle) {
      run();
    } else if (hasIdle) {
      idleId = window.requestIdleCallback(run, { timeout: 3000 });
    } else {
      timeoutId = window.setTimeout(run, 1200);
    }

    return () => {
      cancelled = true;
      if (idleId && "cancelIdleCallback" in window) window.cancelIdleCallback(idleId);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [accounts.length, selectedHandle]);

  // Index mentions by handle, plus counts
  const mentionsByHandle = useMemo(() => {
    const map = new Map();
    for (const t of mentions) {
      const key = t.handle;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    }
    // sort per handle by created_at desc when possible (string sort ok for ISO-ish)
    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    return map;
  }, [mentions]);

  const tweetCountByHandle = useMemo(() => {
    const map = new Map();
    for (const a of visibleAccounts) map.set(a.handle, 0);
    for (const [h, arr] of mentionsByHandle.entries()) map.set(h, arr.length);
    return map;
  }, [visibleAccounts, mentionsByHandle]);

  const stanceListRowsByStance = useMemo(() => {
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    const included = visibleAccounts.filter((a) => {
      const tweetCount = tweetCountByHandle.get(a.handle) || 0;
      const seedStance = String(a.stance ?? a.position ?? "").trim()
        ? normalizedStance(a.stance ?? a.position)
        : "";
      const hasManualStance = Boolean(getStanceForHandle(labels, a.handle) || seedStance);
      return tweetCount > 0 || hasManualStance;
    });
    const mkRow = (a) => {
      const info = getFollowersFromUser(a);
      return {
        handle: a.handle,
        normHandle: normalizeHandle(a.handle) || String(a.handle ?? "").replace(/^@+/, ""),
        name: String(a.name ?? "").trim(),
        followers: info.followers,
        avatarSrc: resolveAvatarUrlForAccount(a, baseNoSlash, missingSrc),
      };
    };
    const out = {
      [STANCE.AGAINST]: [],
      [STANCE.NEUTRAL]: [],
      [STANCE.APPROVE]: [],
    };
    for (const a of included) {
      const stance = getAccountStanceValue(a, labels);
      const row = mkRow(a);
      if (stance === STANCE.AGAINST) out[STANCE.AGAINST].push(row);
      else if (stance === STANCE.APPROVE) out[STANCE.APPROVE].push(row);
      else out[STANCE.NEUTRAL].push(row);
    }
    const sortDesc = (x, y) => y.followers - x.followers;
    out[STANCE.AGAINST].sort(sortDesc);
    out[STANCE.NEUTRAL].sort(sortDesc);
    out[STANCE.APPROVE].sort(sortDesc);
    return out;
  }, [visibleAccounts, tweetCountByHandle, labels]);

  /**
   * Multi-column grid per stance: small avatar + @handle; min row height for legibility.
   * Adds columns until rows fit; if still too tight, min row + scroll. Three stance panels stay equal width/height.
   */
  const stanceListLayout = useMemo(() => {
    if (!stanceListsViewEnabled) return null;
    const na = stanceListRowsByStance[STANCE.AGAINST].length;
    const nn = stanceListRowsByStance[STANCE.NEUTRAL].length;
    const nap = stanceListRowsByStance[STANCE.APPROVE].length;
    const maxN = Math.max(na, nn, nap);
    const isNarrow = w < 720;

    const listRootPad = Math.min(36, Math.max(14, Math.min(h, w) * 0.022)) * 2;
    const innerH = Math.max(80, h - listRootPad);
    const innerW = Math.max(100, w - listRootPad);
    const flexGap = Math.min(14, Math.max(8, innerW * 0.012));
    const gap = Math.min(12, Math.max(6, innerH * 0.012));

    const colHeader = Math.max(26, Math.min(44, innerH * (isNarrow ? 0.062 : 0.072)));
    const scrollPad = Math.max(4, Math.min(10, innerH * 0.012));

    let bodyH;
    if (isNarrow) {
      const bandH = (innerH - gap * 2) / 3;
      bodyH = Math.max(48, bandH - colHeader - scrollPad);
    } else {
      bodyH = Math.max(60, innerH - colHeader - scrollPad);
    }

    const panelW = isNarrow ? innerW - scrollPad : Math.max(70, (innerW - flexGap * 2) / 3 - scrollPad);

    const MIN_ROW = 30;
    const MIN_CELL_W = 104;
    const maxColsByWidth = Math.max(1, Math.min(24, Math.floor(panelW / MIN_CELL_W)));

    let gridCols = 1;
    let rowsNeeded = maxN <= 0 ? 1 : Math.ceil(maxN / gridCols);
    let rowH = bodyH / Math.max(1, rowsNeeded);

    while (rowH < MIN_ROW && gridCols < maxColsByWidth && maxN > 0) {
      gridCols += 1;
      rowsNeeded = Math.ceil(maxN / gridCols);
      rowH = bodyH / Math.max(1, rowsNeeded);
    }

    let scrollOverflow = "hidden";
    if (maxN > 0 && rowH < MIN_ROW) {
      rowH = MIN_ROW;
      scrollOverflow = "auto";
    }

    const cellGap = Math.max(4, Math.min(10, rowH * 0.22));
    const fontSize = Math.max(11, Math.min(14, rowH * 0.48));
    const avatarPx = Math.max(16, Math.min(34, Math.floor(rowH - 8)));
    const headerFont = Math.max(11, Math.min(22, colHeader * 0.46));

    return {
      gridCols,
      rowH,
      cellGap,
      fontSize,
      avatarPx,
      colHeader,
      headerFont,
      isNarrow,
      scrollOverflow,
      bodyH,
      scrollPad,
    };
  }, [stanceListsViewEnabled, stanceListRowsByStance, h, w]);

  const filteredHandlesSet = useMemo(() => {
    const q = normalizeHandleToken(search);
    if (!q) return null;
    const s = new Set();
    for (const a of visibleAccounts) {
      if (normalizeHandleToken(a.handle).includes(q)) s.add(a.handle);
    }
    return s;
  }, [visibleAccounts, search]);

  const searchDropdownResults = useMemo(() => {
    const q = normalizeHandleToken(search);
    if (!q) return [];
    const out = [];
    for (const a of visibleAccounts) {
      const hasMatch = normalizeHandleToken(a.handle).includes(q);
      const inBlob =
        (tweetCountByHandle.get(a.handle) || 0) > 0 ||
        Boolean(getStanceForHandle(labels, a.handle)) ||
        Boolean(String(a.stance ?? a.position ?? "").trim());
      if (hasMatch && inBlob) {
        out.push(a.handle);
        if (out.length >= 12) break;
      }
    }
    return out;
  }, [visibleAccounts, search, tweetCountByHandle, labels]);

  const selectedTweets = useMemo(() => {
    if (!selectedHandle) return [];
    return mentionsByHandle.get(selectedHandle) || [];
  }, [mentionsByHandle, selectedHandle]);

  const visibleCount = useMemo(() => {
    return visibleAccounts.filter(
      (a) => (tweetCountByHandle.get(a.handle) || 0) > 0 || hasAccountStance(a, labels)
    ).length;
  }, [visibleAccounts, tweetCountByHandle, labels]);

  // Preload avatars once accounts are available (deduped URLs; browser HTTP cache + session Image cache).
  useEffect(() => {
    if (!visibleAccounts.length) return;
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    const urls = visibleAccounts.map((a) => resolveAvatarUrlForAccount(a, baseNoSlash, missingSrc));
    preloadAvatarUrls([missingSrc, ...urls], { eager: true });
  }, [visibleAccounts]);

  // Build nodes for simulation
  const nodesRef = useRef([]);
  const simRef = useRef(null);
  const transformRef = useRef({ tx: 0, ty: 0, s: 1 });
  const avatarCacheRef = useRef(new Map());
  const glowCacheRef = useRef(new Map());
  const drawRef = useRef(() => {});
  // Coalesces bursty redraws (e.g. hundreds of cached avatar `load` events firing
  // in the same frame) into a single repaint per animation frame.
  const drawRafRef = useRef(0);

  const camRef = useRef({ scaleMul: 1, panX: 0, panY: 0 });
  const fitRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const isPanningRef = useRef(false);
  const zoomCuePlayedRef = useRef(false);
  const zoomCueRafRef = useRef(0);
  // Async layout settle bookkeeping. While `layoutSettlingRef` is true the graph
  // computes its final positions across animation frames (so the main thread
  // stays responsive and the Stats button opens instantly). Drawing is suppressed
  // during this window so avatars do NOT visibly fly in — they appear once, settled.
  const layoutSettlingRef = useRef(false);
  const settleRafRef = useRef(0);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const labelsRef = useRef({});
  const selectedHandleRef = useRef(null);
  const hoverRef = useRef(null);
  const regionRef = useRef(null);
  const hoverRafScheduledRef = useRef(false);
  const hoverDrawHandleRef = useRef(null);
  const tooltipRef = useRef(null);
  const tooltipHandleRef = useRef(null);
  const tooltipFollowersRef = useRef(null);
  const tooltipAgeRef = useRef(null);
  const tooltipBioRef = useRef(null);
  const tooltipSelfRef = useRef(null);
  const avatarWarnedHandlesRef = useRef(new Set());
  const avatarHookedRef = useRef(new WeakSet());
  const starfieldCanvasRef = useRef(null);
  const starfieldKeyRef = useRef("");
  const stanceZoneCacheRef = useRef(new Map());
  labelsRef.current = labels;
  selectedHandleRef.current = selectedHandle;

  // (Re)create simulation when size/data/shake changes
  useEffect(() => {
    if (loading || err) return;
    if (stanceListsViewEnabled) {
      if (simRef.current) {
        simRef.current.stop();
        simRef.current = null;
      }
      nodesRef.current = [];
      return;
    }
    if (!visibleAccounts.length) return;
    if (w < 10 || h < 10) return;

    const base = getBase();
    const baseNoSlash = base.replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    const avatarSrc = (a) => resolveAvatarUrlForAccount(a, baseNoSlash, missingSrc);

    // Build nodes: accounts that tweeted about bip110, plus manually stance-labeled accounts
    const nodes = visibleAccounts
      .map((a) => {
        const tweetCount = tweetCountByHandle.get(a.handle) || 0;
        const seedStance = String(a.stance ?? a.position ?? "").trim()
          ? normalizedStance(a.stance ?? a.position)
          : "";
        const hasManualStance = Boolean(getStanceForHandle(labelsRef.current, a.handle) || seedStance);
        return { a, tweetCount, hasManualStance, seedStance };
      })
      .filter(({ tweetCount, hasManualStance }) => tweetCount > 0 || hasManualStance)
      .map(({ a, tweetCount, seedStance }) => {
        const rawFollowers = Number(a.followers_count || 0);
        const followersForSize = rawFollowers > 0 ? rawFollowers : (seedStance ? 5000 : 0);
        const side = equalAvatarSizeEnabled ? EQUAL_AVATAR_SIDE : sideFromFollowers(followersForSize);
        const resolvedAvatar = avatarSrc(a);
        const hasStance = Boolean(seedStance);
        if (hasStance && resolvedAvatar === missingSrc && !import.meta.env.PROD) {
          const dbgFields = collectAvatarFieldValues(a);
          // eslint-disable-next-line no-console
          console.log("[avatar-missing][stance-node]", {
            handle: normalizeHandle(a.handle),
            matchedAccountKey: String(a.x_user_id || normalizeHandle(a.handle) || ""),
            stance: seedStance,
            avatarFieldsInspected: dbgFields,
            reason: "No avatar_path or known avatar URL fields present",
          });
        }
        return {
          handle: a.handle,
          x_user_id: String(a.x_user_id ?? a.xUserId ?? "").trim() || null,
          seedStance,
          followers: rawFollowers,
          bio: String(a.bio ?? "").trim() || null,
          accountCreatedAt: a.accountCreatedAt ?? a.account_created_at ?? null,
          hasUserStanceChange: Boolean(a.hasUserStanceChange),
          side,
          half: side / 2,
          tweetCount,
          avatarUrl: resolvedAvatar,
          x: w / 2 + (Math.random() - 0.5) * w * 0.6,
          y: h / 2 + (Math.random() - 0.5) * h * 0.6,
          vx: 0,
          vy: 0,
        };
      });

    nodesRef.current = nodes;
    hoverDrawHandleRef.current = null;

    // Preload avatar images for visible nodes
    const cache = avatarCacheRef.current;
    const warnedHandles = avatarWarnedHandlesRef.current;
    const hooked = avatarHookedRef.current;
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
    const urlToHandles = new Map();
    for (const n of nodes) {
      if (!n.avatarUrl) continue;
      if (!urlToHandles.has(n.avatarUrl)) urlToHandles.set(n.avatarUrl, []);
      urlToHandles.get(n.avatarUrl).push(n.handle);
    }
    const missingImg = getAvatar(missingSrc);
    if ("loading" in missingImg) missingImg.loading = "eager";
    if ("decoding" in missingImg) missingImg.decoding = "async";
    if ("referrerPolicy" in missingImg) missingImg.referrerPolicy = "no-referrer";
    if (!hooked.has(missingImg)) {
      hooked.add(missingImg);
      missingImg.addEventListener("load", () => scheduleDraw());
    }
    const urls = [...new Set(nodes.map((n) => n.avatarUrl).filter(Boolean))];
    urls.forEach((url) => {
      const img = getAvatar(url);
      if ("decoding" in img) img.decoding = "async";
      if ("loading" in img) img.loading = "eager";
      if ("referrerPolicy" in img) img.referrerPolicy = "no-referrer";
      cache.set(url, img);
      if (!hooked.has(img)) {
        hooked.add(img);
        const handleError = (onErrorFired = true) => {
          const handles = urlToHandles.get(url) || [];
          for (const handle of handles) {
            if (warnedHandles.has(handle)) continue;
            warnedHandles.add(handle);
            if (!import.meta.env.PROD) {
              // eslint-disable-next-line no-console
              console.warn("[avatar-load-failed]", {
                handle,
                avatarUrl: url,
                userAgent,
                onErrorFired,
                placeholderFallbackUsed: true,
              });
            }
          }
          if (canonicalAvatarSrc(img.src) !== missingSrc) img.src = missingSrc;
          cache.set(url, missingImg);
          scheduleDraw();
        };
        img.addEventListener("load", () => scheduleDraw());
        img.addEventListener("error", () => handleError(true));
        // If preload finished before listeners were attached, recover immediately.
        if (img.complete) {
          if (img.naturalWidth > 0) scheduleDraw();
          else handleError(false);
        }
      }
    });

    // Stop old sim
    if (simRef.current) simRef.current.stop();

    // "Equal avatar size" mode: skip the force simulation entirely and pack the
    // avatars into a screen-filling grid (uniform size, per-stance columns). The
    // starfield background, fit, and zoom/pan pipeline are all preserved by draw().
    if (equalAvatarSizeEnabled) {
      if (settleRafRef.current) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = 0;
      }
      layoutSettlingRef.current = false;
      simRef.current = null;
      regionRef.current = layoutEqualSizeGrid(nodes, labelsRef.current, w, h);
      draw();
      tryStartNewStancesIntro();
      return () => {};
    }

    // Proportional stance regions (weight = sum sqrt(followers) per stance)
    const regions = computeStanceRegions(nodes, labelsRef.current, w);
    regionRef.current = regions;

    const stanceCenterX = regions
      ? (d) => regions.stanceCenterX[getNodeStance(d, labelsRef.current)] ?? w / 2
      : () => w / 2;

    const sim = forceSimulation(nodes)
      .alpha(1)
      .alphaDecay(0.08)
      .velocityDecay(0.4)
      .force("center", forceCenter(w / 2, h / 2))
      // Plebs mode uses denser per-stance blobs by relaxing hard X bounds and using slightly stronger packing.
      .force("stanceX", forceX(stanceCenterX).strength(plebsMode ? 0.075 : 0.11))
      .force("stanceAnchor", forceStanceAnchor(regionRef, labelsRef, plebsMode ? (isFirefox ? 0.01 : 0.013) : (isFirefox ? 0.012 : 0.016)))
      .force("stanceBounds", plebsMode ? null : forceStanceBounds(regionRef, labelsRef, 0.07))
      .force("pullY", forceY(h / 2).strength(plebsMode ? 0.06 : 0.03))
      .force("charge", forceManyBody().strength(plebsMode ? -6 : -4))
      .force(
        "collide",
        forceCollide((d) => Math.sqrt(2) * d.half + 0.6).iterations(plebsMode ? 3 : 2)
      );

    simRef.current = sim;
    sim.stop(); // static layout: we compute final positions once, then never move

    sim.on("tick", () => {
      draw();
      if (sim.alpha() < 0.01) sim.stop();
    });

    // Fast path: restore the previously settled positions from cache so the graph
    // appears in its FINAL layout immediately on reload — no simulation at all.
    const layoutSig = computeLayoutSignature(nodes, labelsRef.current, w, h, plebsMode, equalAvatarSizeEnabled);
    const cachedPos = loadLayoutPositions(layoutSig);
    const restored = cachedPos ? applyLayoutPositions(nodes, cachedPos) : 0;
    const cacheHit = nodes.length > 0 && restored >= Math.floor(nodes.length * 0.8);

    // Cancel any settle still in flight from a previous effect run so we never
    // have two simulations driving the same nodes at once.
    if (settleRafRef.current) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = 0;
    }

    if (cacheHit) {
      // Previously settled positions restored from cache: paint the final layout
      // immediately. No simulation, no delay.
      layoutSettlingRef.current = false;
      draw();
      tryStartNewStancesIntro();
      return () => {
        sim.stop();
      };
    }

    // Cache miss (first visit / resize / roster or stance change): seed each node
    // near its stance region so the layout converges quickly, then compute the
    // FINAL positions across animation frames. Drawing is suppressed until the
    // layout has fully settled, so avatars appear ONCE in their final spots (no
    // fly-in). Because the work is time-sliced, the main thread stays responsive
    // and UI like the Stats button opens instantly instead of freezing.
    for (const n of nodes) {
      n.x = stanceCenterX(n) + (Math.random() - 0.5) * 60;
      n.y = h / 2 + (Math.random() - 0.5) * Math.min(h * 0.5, 400);
      n.vx = 0;
      n.vy = 0;
    }
    sim.alpha(1);
    layoutSettlingRef.current = true;

    const TOTAL_TICKS = 180;
    let ticksDone = 0;
    const settleChunk = () => {
      const budgetEnd = performance.now() + 8; // ~8ms/frame keeps the UI responsive
      while (ticksDone < TOTAL_TICKS && performance.now() < budgetEnd) {
        sim.tick();
        ticksDone++;
      }
      if (ticksDone < TOTAL_TICKS) {
        settleRafRef.current = requestAnimationFrame(settleChunk);
        return;
      }
      if (!plebsMode) {
        normalizeIslandEdgeGaps(nodes, labelsRef.current, Math.max(16, (regions?.gapPx || 12) * 0.85), 0.5);
      }
      sim.stop();
      saveLayoutPositions(layoutSig, nodes);
      settleRafRef.current = 0;
      layoutSettlingRef.current = false;
      draw(); // single paint of the fully-settled layout
      tryStartNewStancesIntro();
    };
    settleRafRef.current = requestAnimationFrame(settleChunk);

    return () => {
      if (settleRafRef.current) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = 0;
      }
      layoutSettlingRef.current = false;
      sim.stop();
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, err, visibleAccounts.length, w, h, plebsMode, equalAvatarSizeEnabled, stanceListsViewEnabled]);

  // On resize: recompute stance regions and update forces
  useEffect(() => {
    if (stanceListsViewEnabled) return;
    const sim = simRef.current;
    const nodes = nodesRef.current;
    if (!sim || !nodes || nodes.length === 0) return;
    const regions = computeStanceRegions(nodes, labelsRef.current, w);
    regionRef.current = regions;
    const stanceCenterX = regions
      ? (d) => regions.stanceCenterX[getNodeStance(d, labelsRef.current)] ?? w / 2
      : () => w / 2;
    sim.force("center", forceCenter(w / 2, h / 2));
    sim.force("stanceX", forceX(stanceCenterX).strength(0.11));
    sim.force("pullY", forceY(h / 2).strength(0.03));
    normalizeIslandEdgeGaps(nodes, labelsRef.current, Math.max(16, (regions?.gapPx || 12) * 0.85), 0.4);
    drawRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, stanceListsViewEnabled]);

  // On stance change: recompute regions, update forces, run short reflow then stop (keeps layout static, no lag)
  useEffect(() => {
    labelsRef.current = labels;
    const sim = simRef.current;
    const nodes = nodesRef.current;
    // Equal-size grid mode: re-pack the grid so nodes move to their new stance
    // column when a stance changes (no force sim involved).
    if (equalAvatarSizeEnabled) {
      if (nodes && nodes.length > 0) {
        regionRef.current = layoutEqualSizeGrid(nodes, labels, w, h);
      }
      draw();
      return;
    }
    if (!sim || !nodes || nodes.length === 0) {
      draw();
      return;
    }
    // The initial layout is still computing (it already uses the current labels).
    // Don't start a competing settle; the mount effect will paint when done.
    if (layoutSettlingRef.current) return;

    const regions = computeStanceRegions(nodes, labels, w);
    regionRef.current = regions;
    const stanceCenterX = regions
      ? (d) => regions.stanceCenterX[getNodeStance(d, labels)] ?? w / 2
      : () => w / 2;
    sim.force("stanceX", forceX(stanceCenterX).strength(0.11));

    // Reflow after a stance change across animation frames (no fly-in: drawing is
    // suppressed until the reflow settles, then painted once).
    if (settleRafRef.current) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = 0;
    }
    sim.alpha(0.8);
    layoutSettlingRef.current = true;
    const TOTAL_TICKS = 90;
    let ticksDone = 0;
    const settleChunk = () => {
      const budgetEnd = performance.now() + 8;
      while (ticksDone < TOTAL_TICKS && performance.now() < budgetEnd) {
        sim.tick();
        ticksDone++;
      }
      if (ticksDone < TOTAL_TICKS) {
        settleRafRef.current = requestAnimationFrame(settleChunk);
        return;
      }
      normalizeIslandEdgeGaps(nodes, labels, Math.max(16, (regions?.gapPx || 12) * 0.85), 0.5);
      sim.stop();
      settleRafRef.current = 0;
      layoutSettlingRef.current = false;
      draw();
    };
    settleRafRef.current = requestAnimationFrame(settleChunk);

    return () => {
      if (settleRafRef.current) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = 0;
      }
      layoutSettlingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels]);

  useEffect(() => {
    if (loading || err || layoutSettlingRef.current) return;
    if (stanceListsViewEnabled || !nodesRef.current?.length) return;
    tryStartNewStancesIntro();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, loading, err]);

  useEffect(() => {
    refreshIntroStagingPositions();
    if (newStancesIntroRef.current.active) scheduleDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, headerHeightPx]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHandle]);

  useEffect(() => {
    return () => {
      if (zoomCueRafRef.current) cancelAnimationFrame(zoomCueRafRef.current);
      if (drawRafRef.current) cancelAnimationFrame(drawRafRef.current);
      if (settleRafRef.current) cancelAnimationFrame(settleRafRef.current);
      const intro = newStancesIntroRef.current;
      if (intro.rafId) cancelAnimationFrame(intro.rafId);
      intro.rafId = 0;
      intro.active = false;
    };
  }, []);

  useEffect(() => {
    if (zoomCuePlayedRef.current) return;
    if (loading || err) return;
    if (stanceListsViewEnabled) return;
    if (!visibleAccounts.length || w < 10 || h < 10) return;

    zoomCuePlayedRef.current = true;
    const baselinePanX = Number.isFinite(camRef.current.panX) ? camRef.current.panX : 0;
    const baselinePanY = Number.isFinite(camRef.current.panY) ? camRef.current.panY : 0;
    const baseline = Number.isFinite(camRef.current.scaleMul) && camRef.current.scaleMul > 0
      ? camRef.current.scaleMul
      : 1;
    const zoomOutMul = baseline * 0.96; // subtle ~4% zoom-out cue
    const startDelayMs = 180;
    const durationMs = 560;
    const startAt = performance.now() + startDelayMs;
    const centerX = w / 2;
    const centerY = h / 2;
    const fitAtStart = fitRef.current || { scale: 1, tx: 0, ty: 0 };
    const viewAtStart = viewRef.current || {
      scale: fitAtStart.scale * baseline,
      tx: fitAtStart.tx + baselinePanX,
      ty: fitAtStart.ty + baselinePanY,
    };
    const worldAnchorX = (centerX - viewAtStart.tx) / (viewAtStart.scale || 1);
    const worldAnchorY = (centerY - viewAtStart.ty) / (viewAtStart.scale || 1);

    const step = (now) => {
      if (now < startAt) {
        zoomCueRafRef.current = requestAnimationFrame(step);
        return;
      }
      const t = Math.min(1, (now - startAt) / durationMs);
      // 0 -> 1 -> 0 curve so we zoom out then return smoothly.
      const wave = Math.sin(Math.PI * t);
      const nextScaleMul = baseline - (baseline - zoomOutMul) * wave;
      const fit = fitRef.current || fitAtStart;
      const nextWorldScale = (fit.scale || 1) * nextScaleMul;
      const nextPanX = centerX - fit.tx - worldAnchorX * nextWorldScale;
      const nextPanY = centerY - fit.ty - worldAnchorY * nextWorldScale;
      camRef.current = { ...camRef.current, scaleMul: nextScaleMul, panX: nextPanX, panY: nextPanY };
      drawRef.current();
      if (t < 1) {
        zoomCueRafRef.current = requestAnimationFrame(step);
      } else {
        camRef.current = { ...camRef.current, scaleMul: baseline, panX: baselinePanX, panY: baselinePanY };
        drawRef.current();
        zoomCueRafRef.current = 0;
      }
    };

    zoomCueRafRef.current = requestAnimationFrame(step);
    return () => {
      if (zoomCueRafRef.current) cancelAnimationFrame(zoomCueRafRef.current);
      zoomCueRafRef.current = 0;
    };
  }, [loading, err, visibleAccounts.length, w, h, stanceListsViewEnabled]);

  function updateHoverOverlay(nextHover) {
    const tip = tooltipRef.current;
    if (!tip) return;
    if (!nextHover) {
      tip.style.display = "none";
      return;
    }
    const left = clamp(nextHover.x + 12, 8, Math.max(8, w - 260));
    const top = clamp(nextHover.y + 12, 8, Math.max(8, h - 160));
    tip.style.display = "block";
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    const isSelfHover = safeLower(nextHover.handle) === meHandleLower;
    if (tooltipHandleRef.current) tooltipHandleRef.current.textContent = `@${nextHover.handle}`;
    if (tooltipFollowersRef.current) {
      tooltipFollowersRef.current.textContent = `followers: ${formatNum(nextHover.followers)}`;
    }
    const bio = String(nextHover.bio ?? "").trim();
    if (tooltipBioRef.current) {
      tooltipBioRef.current.style.display = bio ? "block" : "none";
      tooltipBioRef.current.textContent = bio;
    }
    if (tooltipSelfRef.current) {
      tooltipSelfRef.current.style.display = isSelfHover ? "inline-block" : "none";
    }
  }

  // Drawing
  function getStarfieldCanvas(cw, ch, dpr) {
    const key = `${cw}x${ch}|${dpr}|${isFirefox ? "ff" : "std"}`;
    if (starfieldCanvasRef.current && starfieldKeyRef.current === key) return starfieldCanvasRef.current;
    const off = document.createElement("canvas");
    off.width = Math.floor(cw * dpr);
    off.height = Math.floor(ch * dpr);
    const sctx = off.getContext("2d");
    if (sctx) {
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, cw, ch);
      sctx.fillStyle = "rgba(255,255,255,0.4)";
      const starCount = isFirefox ? 48 : 120;
      for (let i = 0; i < starCount; i++) {
        const x = (i * 137.5 + 13) % (cw + 2);
        const y = (i * 97.3 + 17) % (ch + 2);
        const r = (i % 3 === 0) ? 1 : 0.5;
        sctx.beginPath();
        sctx.arc(x, y, r, 0, Math.PI * 2);
        sctx.fill();
      }
    }
    starfieldCanvasRef.current = off;
    starfieldKeyRef.current = key;
    return off;
  }

  // Batches redraw requests to at most one per frame. Use this (instead of
  // calling draw() directly) for events that can fire in large bursts, such as
  // cached avatar images all resolving their `load` handlers at once.
  function scheduleDraw() {
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      drawRef.current();
    });
  }

  function getNewStancesStagingView() {
    const fit = fitRef.current;
    const view = viewRef.current;
    const r = regionRef.current;
    return {
      cw: Math.max(1, w),
      ch: Math.max(1, h),
      headerHeight: headerHeightPx,
      scale: view?.scale ?? fit?.scale ?? 1,
      tx: view?.tx ?? fit?.tx ?? 0,
      ty: view?.ty ?? fit?.ty ?? 0,
      stanceCenterX: {
        [STANCE.AGAINST]: r?.stanceCenterX?.[STANCE.AGAINST] ?? w * 0.33,
        [STANCE.NEUTRAL]: r?.stanceCenterX?.[STANCE.NEUTRAL] ?? w * 0.5,
        [STANCE.APPROVE]: r?.stanceCenterX?.[STANCE.APPROVE] ?? w * 0.67,
      },
    };
  }

  function refreshIntroStagingPositions() {
    const intro = newStancesIntroRef.current;
    if (!intro.active || !intro.items.length) return;
    const layouts = computeStagingLayouts(intro.items, getNewStancesStagingView());
    intro.items = intro.items.map((it) => {
      const lay = layouts.get(it.xUserId);
      return lay
        ? { ...it, stagingSx: lay.sx, stagingSy: lay.sy, stagingSidePx: lay.stagingSidePx }
        : it;
    });
  }

  function finishNewStancesIntro() {
    const intro = newStancesIntroRef.current;
    if (intro.rafId) cancelAnimationFrame(intro.rafId);
    intro.rafId = 0;
    intro.active = false;
    const markerEvents = intro.markerEvents;
    intro.items = [];
    intro.hiddenIds = new Set();
    intro.hiddenHandles = new Set();
    intro.landedIds = new Set();
    intro.landedHandles = new Set();
    intro.markerEvents = [];
    intro.phase = "done";

    const debug = parseDebugNewStancesParams(typeof window !== "undefined" ? window.location.search : "");
    const decision = resolveShowIntroDecision({
      publicEnabled: NEW_STANCES_PUBLIC_ENABLED,
      debug,
    });
    clearPlayingSession(sessionStorage);
    if (shouldPersistMarker(decision) && markerEvents.length) {
      const marker = pickNewestMarker(markerEvents);
      if (marker) writeLastSeenMarker(localStorage, marker);
    }
    setNewStancesUi({ headingOpacity: 0, debug: false, bandActive: false });
    scheduleDraw();
  }

  function newStancesIntroTick() {
    const intro = newStancesIntroRef.current;
    if (!intro.active) return;
    const now = performance.now();
    const elapsed = now - intro.startedAt;
    intro.phase = getIntroPhase(elapsed, intro.reducedMotion);
    const headingOpacity = headingOpacityForPhase(
      intro.phase,
      elapsed,
      intro.reducedMotion,
      intro.items.length
    );
    setNewStancesUi((prev) =>
      prev.headingOpacity === headingOpacity
        ? prev
        : { ...prev, headingOpacity }
    );

    for (const item of intro.items) {
      if (!item.landed && now >= item.flightEnd) {
        item.landed = true;
        intro.landedIds.add(item.xUserId);
        if (item.handle) intro.landedHandles.add(normalizeHandle(item.handle));
      }
    }

    if (intro.phase === "done") {
      finishNewStancesIntro();
      return;
    }
    scheduleDraw();
    intro.rafId = requestAnimationFrame(newStancesIntroTick);
  }

  async function tryStartNewStancesIntro() {
    const intro = newStancesIntroRef.current;
    if (intro.active) return;
    if (stanceListsViewEnabled || historyPlaybackRef.current.active) return;
    if (layoutSettlingRef.current) return;

    const debug = parseDebugNewStancesParams(typeof window !== "undefined" ? window.location.search : "");
    const decision = resolveShowIntroDecision({
      publicEnabled: NEW_STANCES_PUBLIC_ENABLED,
      debug,
    });
    if (!decision.show) return;

    const playing = readPlayingSession(sessionStorage);
    if (shouldDeferIntroForPlayingSession(playing, decision)) {
      return;
    }
    if (!lockIntroSession()) return;

    const marker =
      decision.publicEnabled && !decision.debug.enabled ? readLastSeenMarker(localStorage) : null;
    const afterEventId = resolveFetchAfterEventId({
      publicEnabled: decision.publicEnabled,
      debug: decision.debug,
      marker,
    });
    const limit = decision.debug.enabled ? debug.limit : 9;

    let events = [];
    try {
      events = await fetchNewStanceEvents({ afterEventId, limit });
    } catch {
      return;
    }
    events = normalizeIntroEvents(events, limit);
    if (!events.length) return;

    const nodes = nodesRef.current;
    if (!nodes?.length) return;

    const base = getBase();
    const baseNoSlash = base.replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);

    const items = matchEventsToIntroItems(events, nodes, (e, nodeUrl) => {
      const path = String(e.avatarPath ?? "").trim();
      if (path) {
        const rel = path.startsWith("/") ? path : `/${path}`;
        return canonicalAvatarSrc(`${baseNoSlash}${rel}`);
      }
      return nodeUrl || missingSrc;
    });
    if (!items.length) return;

    const cache = avatarCacheRef.current;
    const hooked = avatarHookedRef.current;
    for (const it of items) {
      const url = it.avatarUrl;
      if (!url) continue;
      const img = getAvatar(url);
      cache.set(url, img);
      if (!hooked.has(img)) {
        hooked.add(img);
        img.addEventListener("load", () => scheduleDraw());
        img.addEventListener("error", () => scheduleDraw());
      }
    }
    preloadAvatarUrls(
      items.map((it) => it.avatarUrl),
      { eager: true }
    );

    const layouts = computeStagingLayouts(items, getNewStancesStagingView());
    for (const it of items) {
      const lay = layouts.get(it.xUserId);
      if (lay) {
        it.stagingSx = lay.sx;
        it.stagingSy = lay.sy;
        it.stagingSidePx = lay.stagingSidePx;
      }
    }

    const reducedMotion = prefersReducedMotion();
    intro.active = true;
    intro.startedAt = performance.now();
    const flightBase = intro.startedAt + INTRO_TIMING.holdMs;
    const scheduled = scheduleFlightTimes(items, flightBase, reducedMotion);

    intro.items = scheduled;
    intro.hiddenIds = new Set(scheduled.map((it) => it.xUserId));
    intro.hiddenHandles = new Set(scheduled.map((it) => normalizeHandle(it.handle)).filter(Boolean));
    intro.landedIds = new Set();
    intro.reducedMotion = reducedMotion;
    intro.batchId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    intro.markerEvents = markerEventsFromIntroItems(scheduled);
    intro.phase = "fade-in";

    if (decision.publicEnabled && !decision.debug.enabled) {
      writePlayingSession(sessionStorage, {
        batchId: intro.batchId,
        eventIds: scheduled.map((it) => it.eventId),
        startedAt: new Date().toISOString(),
      });
    }

    setNewStancesUi({ headingOpacity: 0, debug: debug.enabled, bandActive: true });
    if (intro.rafId) cancelAnimationFrame(intro.rafId);
    intro.rafId = requestAnimationFrame(newStancesIntroTick);
    scheduleDraw();
  }

  function draw() {
    drawRef.current = draw;

    // Suppress intermediate paints while the layout is settling off the main
    // thread. This prevents avatar `load` events and simulation ticks from
    // showing nodes mid-flight; we paint exactly once when settling completes.
    if (layoutSettlingRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rawDpr = window.devicePixelRatio || 1;
    const dpr = isFirefox ? Math.min(rawDpr, 1.5) : rawDpr;
    const cw = Math.max(1, w);
    const ch = Math.max(1, h);

    if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
      canvas.width = Math.floor(cw * dpr);
      canvas.height = Math.floor(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    ctx.clearRect(0, 0, cw, ch);

    // Cached starfield (screen space)
    const starfield = getStarfieldCanvas(cw, ch, dpr);
    if (starfield) ctx.drawImage(starfield, 0, 0, cw, ch);

    const nodes = nodesRef.current;
    const qset = filteredHandlesSet;
    const avatarCache = avatarCacheRef.current;
    const pb = historyPlaybackRef.current;
    const playbackActive = Boolean(pb.active);
    const intro = newStancesIntroRef.current;
    const introActive = Boolean(intro.active);

    if (!nodes || nodes.length === 0) return;

    const introShowsWorldNode = (n) => {
      if (!introActive) return true;
      const xid = String(n.x_user_id ?? "").trim();
      const nh = normalizeHandle(n.handle);
      if (xid && isIntroNodeHidden(xid, intro.hiddenIds, intro.landedIds)) return false;
      if (nh && intro.hiddenHandles.has(nh) && !intro.landedHandles.has(nh)) return false;
      return true;
    };

    const contributesToPlaybackFit = (n) => {
      if (!playbackActive) return true;
      if (!n.hasUserStanceChange) return true;
      const h = normalizeHandle(n.handle);
      return pb.played.has(h);
    };

    const playbackShowsWorldNode = (n) => {
      if (!playbackActive) return true;
      if (!n.hasUserStanceChange) return true;
      const h = normalizeHandle(n.handle);
      if (pb.played.has(h)) return true;
      const cur = pb.currentHandle ? normalizeHandle(pb.currentHandle) : "";
      if (cur === h && (pb.phase === "hold" || pb.phase === "move")) return false;
      return false;
    };

    const maxDrawScale = 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (playbackActive && !contributesToPlaybackFit(n)) continue;
      const half = (n.side * maxDrawScale) / 2;
      const x0 = n.x - half, y0 = n.y - half, x1 = n.x + half, y1 = n.y + half;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }

    const blobW = Math.max(1, maxX - minX);
    const blobH = Math.max(1, maxY - minY);
    const pad = 28;
    const fitScale = Math.min((cw - pad * 2) / blobW, (ch - pad * 2) / blobH) * 0.96;
    const blobCx = (minX + maxX) / 2;
    const blobCy = (minY + maxY) / 2;
    const fitTx = cw / 2 - blobCx * fitScale;
    const fitTy = ch / 2 - blobCy * fitScale;

    fitRef.current = { scale: fitScale, tx: fitTx, ty: fitTy };

    const user = camRef.current;
    const scale = fitScale * user.scaleMul;
    const tx = fitTx + user.panX;
    const ty = fitTy + user.panY;

    viewRef.current = { scale, tx, ty };

    // Subtle stance anchor zones (cached radial sprites), rendered behind nodes.
    const r = regionRef.current;
    const againstCx = r?.stanceCenterX?.[STANCE.AGAINST] ?? (w * 0.33);
    const neutralCx = r?.stanceCenterX?.[STANCE.NEUTRAL] ?? (w * 0.5);
    const approveCx = r?.stanceCenterX?.[STANCE.APPROVE] ?? (w * 0.67);
    const zoneCyWorld = h / 2;
    const againstX = againstCx * scale + tx;
    const neutralX = neutralCx * scale + tx;
    const approveX = approveCx * scale + tx;
    const zoneY = zoneCyWorld * scale + ty;
    const baseRadius = Math.min(cw, ch) * (isFirefox ? 0.28 : 0.31);
    const zoneRadius = Math.max(120, Math.min(420, baseRadius));
    const getZone = (key, rgb, alpha) => {
      const cacheKey = `${key}|${Math.round(zoneRadius)}|${alpha}|${isFirefox ? "ff" : "std"}`;
      const cache = stanceZoneCacheRef.current;
      if (cache.has(cacheKey)) return cache.get(cacheKey);
      const sprite = createStanceZoneSprite(rgb, zoneRadius, alpha);
      if (cache.size > 24) cache.clear();
      cache.set(cacheKey, sprite);
      return sprite;
    };
    const redZone = getZone("red", [220, 38, 38], isFirefox ? 0.055 : 0.07);
    const neutralZone = getZone("neutral", [156, 163, 175], isFirefox ? 0.032 : 0.042);
    const greenZone = getZone("green", [34, 197, 94], isFirefox ? 0.055 : 0.07);
    const drawZone = (sprite, cx, cy) => {
      const rad = sprite.width / 2;
      ctx.drawImage(sprite, cx - rad, cy - rad);
    };
    drawZone(redZone, againstX, zoneY);
    drawZone(neutralZone, neutralX, zoneY);
    drawZone(greenZone, approveX, zoneY);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const radius = (side) => Math.min(14, side * 0.22);
    const glowQuality = isFirefox ? 0.48 : 1;
    const nonEmphasizedGlowPasses = isFirefox ? 1 : 3;
    const getGlow = (aura, drawSide, emphasize) => {
      const bucketSide = Math.max(6, Math.round(drawSide));
      const key = `${aura}|${bucketSide}|${emphasize ? "1" : "0"}|${isFirefox ? "ff" : "std"}`;
      const cacheKey = `${GLOW_CACHE_VERSION}|${key}`;
      const cache = glowCacheRef.current;
      if (cache.has(cacheKey)) return cache.get(cacheKey);
      const sprite = createGlowSprite(aura, bucketSide, emphasize, glowQuality);
      if (cache.size > 420) cache.clear();
      cache.set(cacheKey, sprite);
      return sprite;
    };
    const drawNode = (n, scaleFactor, emphasize = false) => {
      const shouldDim =
        !playbackActive &&
        dimOthersEnabled &&
        Boolean(curSelected) &&
        n.handle !== curSelected;
      ctx.save();
      if (shouldDim) {
        ctx.globalAlpha *= 0.6;
      }
      const drawHalf = (n.side * scaleFactor) / 2;
      const drawX = n.x - drawHalf;
      const drawY = n.y - drawHalf;
      const drawSide = n.side * scaleFactor;
      const r = radius(drawSide);
      const isSelected = curSelected && n.handle === curSelected;
      const isHovered = curHover && n.handle === curHover.handle;
      const isInSearch = qset ? qset.has(n.handle) : true;
      const alpha = playbackActive || isInSearch ? 1 : 0.12;
      const stance = getNodeStance(n, labels);
      const aura = stanceColor(stance);
      const baseFill =
        aura && n.tweetCount > 0
          ? aura.replace(/[\d.]+\)$/, `${0.16 * alpha})`)
          : n.tweetCount > 0
            ? "rgba(40,45,55," + alpha + ")"
            : "rgba(70,75,85," + alpha + ")";
      const baseStroke = aura
        ? aura.replace(/[\d.]+\)$/, `${0.72 * alpha})`)
        : "rgba(120,130,150," + alpha + ")";
      if (aura) {
        const glow = getGlow(aura, drawSide, emphasize);
        if (glow && glow.canvas) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = emphasize ? 1 : 1;
          ctx.drawImage(glow.canvas, drawX - glow.pad, drawY - glow.pad);
          if (!emphasize) {
            // Multi-pass only on non-Firefox profile.
            for (let p = 1; p < nonEmphasizedGlowPasses; p++) {
              ctx.drawImage(glow.canvas, drawX - glow.pad, drawY - glow.pad);
            }
          }
          ctx.restore();
        }
      }

      const img = n.avatarUrl ? avatarCache.get(n.avatarUrl) : null;
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.save();
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(drawX, drawY, drawSide, drawSide, r);
        } else {
          ctx.rect(drawX, drawY, drawSide, drawSide);
        }
        ctx.clip();
        ctx.drawImage(img, drawX, drawY, drawSide, drawSide);
        ctx.restore();
      } else {
        ctx.fillStyle = baseFill;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(drawX, drawY, drawSide, drawSide, r);
        } else {
          ctx.rect(drawX, drawY, drawSide, drawSide);
        }
        ctx.fill();
      }
      ctx.strokeStyle = baseStroke;
      ctx.lineWidth = (isSelected ? 3 : isHovered ? 2 : 1) / scale;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(drawX, drawY, drawSide, drawSide, r);
      } else {
        ctx.rect(drawX, drawY, drawSide, drawSide);
      }
      ctx.stroke();
      ctx.restore();
    };

    const curHover = hoverRef.current;
    const curSelected = selectedHandleRef.current;
    const base = [], hovered = [], selected = [];
    const hoverScale = 1.14;
    const selectedScaleBase = isFirefox ? 1.72 : 2;
    const selectedPulseScale =
      pulseSelectedEnabled && curSelected
        ? 1 + Math.sin(performance.now() * 0.005) * 0.06
        : 1;
    const selectedScale = selectedScaleBase * selectedPulseScale;
    const cullMargin = 28;
    const isVisible = (n, scaleFactor) => {
      const halfPx = (n.side * scaleFactor * scale) / 2;
      const sx = n.x * scale + tx;
      const sy = n.y * scale + ty;
      return (
        sx + halfPx >= -cullMargin &&
        sx - halfPx <= cw + cullMargin &&
        sy + halfPx >= -cullMargin &&
        sy - halfPx <= ch + cullMargin
      );
    };
    for (const n of nodes) {
      if (!playbackShowsWorldNode(n)) continue;
      if (!introShowsWorldNode(n)) continue;
      if (curSelected && n.handle === curSelected) {
        if (isVisible(n, selectedScale)) selected.push(n);
      } else if (curHover && n.handle === curHover.handle) {
        if (isVisible(n, hoverScale)) hovered.push(n);
      } else if (isVisible(n, 1)) {
        base.push(n);
      }
    }
    for (const n of base) drawNode(n, 1, false);
    for (const n of hovered) drawNode(n, hoverScale, true);
    for (const n of selected) drawNode(n, selectedScale, true);

    ctx.restore();

    if (playbackActive && pb.currentHandle && (pb.phase === "hold" || pb.phase === "move")) {
      const nowOv = performance.now();
      const nh = normalizeHandle(pb.currentHandle);
      const nin = nodes.find((nn) => normalizeHandle(nn.handle) === nh);
      if (nin) {
        const stanceOv = getNodeStance(nin, labels);
        const auraOv = stanceColor(stanceOv);
        const finalCx = nin.x * scale + tx;
        const finalCy = nin.y * scale + ty;
        const finalSide = nin.side * scale;
        const bigMult = 2.45;
        const centerCx = cw / 2;
        const centerCy = ch / 2;
        const bigSide = Math.max(finalSide * bigMult, Math.min(cw, ch) * 0.2);
        let cx = centerCx;
        let cy = centerCy;
        let sidePx = bigSide;
        if (pb.phase === "move") {
          const tm = pb.moveMs > 0 ? clamp((nowOv - pb.phaseStart) / pb.moveMs, 0, 1) : 1;
          const e = tm < 0.5 ? 2 * tm * tm : 1 - (-2 * tm + 2) ** 2 / 2;
          cx = centerCx + (finalCx - centerCx) * e;
          cy = centerCy + (finalCy - centerCy) * e;
          sidePx = bigSide + (finalSide - bigSide) * e;
        }
        const drawX = cx - sidePx / 2;
        const drawY = cy - sidePx / 2;
        const rOv = Math.min(14, sidePx * 0.22);
        if (auraOv) {
          const glow = getGlow(auraOv, sidePx, true);
          if (glow?.canvas) {
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.drawImage(glow.canvas, drawX - glow.pad, drawY - glow.pad);
            ctx.restore();
          }
        }
        const img = nin.avatarUrl ? avatarCache.get(nin.avatarUrl) : null;
        if (img?.complete && img.naturalWidth > 0) {
          ctx.save();
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
          } else {
            ctx.rect(drawX, drawY, sidePx, sidePx);
          }
          ctx.clip();
          ctx.drawImage(img, drawX, drawY, sidePx, sidePx);
          ctx.restore();
        } else {
          ctx.fillStyle = auraOv ? auraOv.replace(/[\d.]+\)$/, "0.22)") : "rgba(70,75,85,0.35)";
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
          } else {
            ctx.rect(drawX, drawY, sidePx, sidePx);
          }
          ctx.fill();
        }
        ctx.strokeStyle = auraOv ? auraOv.replace(/[\d.]+\)$/, "0.85)") : "rgba(120,130,150,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
        } else {
          ctx.rect(drawX, drawY, sidePx, sidePx);
        }
        ctx.stroke();
      }
    }

    if (introActive && intro.items.length) {
      const nowIntro = performance.now();
      const elapsedIntro = nowIntro - intro.startedAt;
      const viewIntro = getNewStancesStagingView();
      const stagingSide = intro.items[0]?.stagingSidePx || 48;
      const panelBounds = computeStagingPanelBounds(intro.items.length, stagingSide, viewIntro);
      const panelAlpha = stagingPanelOpacityForPhase(
        intro.phase,
        elapsedIntro,
        intro.items.length,
        intro.reducedMotion
      );
      if (panelAlpha > 0.01) {
        const { x, y, w, h, r } = panelBounds;
        ctx.save();
        ctx.globalAlpha = panelAlpha;
        ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(x, y, w, h, r);
        } else {
          ctx.rect(x, y, w, h);
        }
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      const fadeAlpha =
        intro.phase === "fade-in"
          ? easeInOutCubic(elapsedIntro / INTRO_TIMING.fadeInMs)
          : 1;
      for (const item of intro.items) {
        if (item.landed) continue;
        const pos = computeFlightScreenPos(item, nowIntro, viewIntro, intro.reducedMotion);
        const sidePx = Math.max(8, pos.sidePx);
        const drawX = pos.sx - sidePx / 2;
        const drawY = pos.sy - sidePx / 2;
        const rOv = Math.min(14, sidePx * 0.22);
        const auraIntro = stanceColor(item.stance);
        ctx.save();
        ctx.globalAlpha = fadeAlpha;
        const baseFill = auraIntro
          ? auraIntro.replace(/[\d.]+\)$/, "0.18)")
          : "rgba(70,75,85,0.35)";
        ctx.fillStyle = baseFill;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
        } else {
          ctx.rect(drawX, drawY, sidePx, sidePx);
        }
        ctx.fill();
        const img = item.avatarUrl ? getAvatar(item.avatarUrl) : null;
        if (img?.complete && img.naturalWidth > 0) {
          ctx.save();
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") {
            ctx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
          } else {
            ctx.rect(drawX, drawY, sidePx, sidePx);
          }
          ctx.clip();
          ctx.drawImage(img, drawX, drawY, sidePx, sidePx);
          ctx.restore();
        }
        ctx.strokeStyle = auraIntro ? auraIntro.replace(/[\d.]+\)$/, "0.9)") : "rgba(120,130,150,0.9)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") {
          ctx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
        } else {
          ctx.rect(drawX, drawY, sidePx, sidePx);
        }
        ctx.stroke();
        if (pos.labelOpacity > 0.02 && item.handle) {
          ctx.globalAlpha = fadeAlpha * pos.labelOpacity;
          const fontSize = Math.max(10, Math.min(12, sidePx * 0.17));
          ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
          ctx.fillStyle = "rgba(255,255,255,0.94)";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(formatIntroHandleLabel(item.handle), pos.sx, drawY + sidePx + INTRO_LABEL_GAP_PX);
        }
        ctx.restore();
      }
    }
  }

  function historyPlaybackResolvePlayable() {
    const raw = stancePlaybackItemsRef.current;
    const nodeList = nodesRef.current || [];
    if (!raw?.length || !nodeList.length) return [];
    const out = [];
    const seen = new Set();
    for (const it of raw) {
      const h = normalizeHandle(it.handle);
      if (!h || seen.has(h)) continue;
      const n = nodeList.find((nn) => normalizeHandle(nn.handle) === h);
      if (!n || !n.hasUserStanceChange) continue;
      const stance = getNodeStance(n, labelsRef.current);
      if (!stance) continue;
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      seen.add(h);
      out.push({ handle: n.handle });
    }
    return out;
  }

  function historyPlaybackAdvance(pb, now) {
    while (pb.index < pb.sequence.length) {
      const item = pb.sequence[pb.index];
      const h = normalizeHandle(item?.handle);
      const n = nodesRef.current.find((nn) => normalizeHandle(nn.handle) === h);
      pb.index += 1;
      if (!n || !n.hasUserStanceChange) continue;
      const stance = getNodeStance(n, labelsRef.current);
      if (!stance || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      pb.currentHandle = n.handle;
      pb.phase = "hold";
      pb.phaseStart = now;
      return true;
    }
    return false;
  }

  function historyPlaybackTick() {
    const pb = historyPlaybackRef.current;
    if (!pb.active) return;
    const now = performance.now();
    const elapsed = now - pb.phaseStart;
    if (pb.phase === "hold") {
      if (elapsed >= pb.holdMs) {
        pb.phase = "move";
        pb.phaseStart = now;
      }
    } else if (pb.phase === "move") {
      if (elapsed >= pb.moveMs) {
        const ch = pb.currentHandle;
        if (ch) pb.played.add(normalizeHandle(ch));
        pb.phase = "gap";
        pb.phaseStart = now;
      }
    } else if (pb.phase === "gap") {
      if (elapsed >= pb.gapMs) {
        if (!historyPlaybackAdvance(pb, now)) {
          if (pb.rafId) cancelAnimationFrame(pb.rafId);
          pb.rafId = 0;
          pb.active = false;
          pb.currentHandle = null;
          pb.phase = "idle";
          pb.played = new Set();
          pb.sequence = [];
          setHistoryPlaybackHasFinishedOnce(true);
          setHistoryPlaybackPlaying(false);
          drawRef.current();
          return;
        }
      }
    }
    drawRef.current();
    pb.rafId = requestAnimationFrame(historyPlaybackTick);
  }

  function stopHistoryPlayback() {
    const pb = historyPlaybackRef.current;
    if (pb.rafId) cancelAnimationFrame(pb.rafId);
    pb.rafId = 0;
    pb.active = false;
    pb.currentHandle = null;
    pb.phase = "idle";
    pb.played = new Set();
    pb.sequence = [];
    pb.index = 0;
    setHistoryPlaybackPlaying(false);
    drawRef.current();
  }

  function applyStanceListsView(on) {
    if (on) {
      stopHistoryPlayback();
      setPlebsMode(false);
      setInfluencersMode(false);
      setManualEditMode(false);
      void setEqualAvatarSizePreference(false);
      setStanceListsViewEnabled(true);
    } else {
      setStanceListsViewEnabled(false);
    }
  }

  function beginHistoryPlayback() {
    const pb = historyPlaybackRef.current;
    if (pb.rafId) cancelAnimationFrame(pb.rafId);
    pb.rafId = 0;
    pb.active = false;
    pb.currentHandle = null;
    pb.phase = "idle";
    pb.played = new Set();
    pb.sequence = [];
    pb.index = 0;

    const sequence = historyPlaybackResolvePlayable();
    if (!sequence.length) return;

    const count = sequence.length;
    const totalBudget = 60000;
    const stepDuration = clamp(Math.round(totalBudget / count), 200, 520);
    const holdMs = clamp(Math.round(stepDuration * 0.24), 80, 120);
    const moveMs = clamp(Math.round(stepDuration * 0.62), 200, 340);
    const gapMs = Math.max(12, stepDuration - holdMs - moveMs);

    pb.active = true;
    pb.sequence = sequence;
    pb.index = 0;
    pb.holdMs = holdMs;
    pb.moveMs = moveMs;
    pb.gapMs = gapMs;
    setHistoryPlaybackPlaying(true);

    const t0 = performance.now();
    if (!historyPlaybackAdvance(pb, t0)) {
      pb.active = false;
      setHistoryPlaybackPlaying(false);
      drawRef.current();
      return;
    }
    pb.rafId = requestAnimationFrame(historyPlaybackTick);
    drawRef.current();
  }

  // Hit test squares (screen -> world using current view)
  function hitTest(mx, my) {
    const v = viewRef.current || { scale: 1, tx: 0, ty: 0 };
    const wx = (mx - v.tx) / v.scale;
    const wy = (my - v.ty) / v.scale;
    const nodes = nodesRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const x = n.x - n.half;
      const y = n.y - n.half;
      if (wx >= x && wx <= x + n.side && wy >= y && wy <= y + n.side) return n;
    }
    return null;
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    isPanningRef.current = true;
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: camRef.current.panX,
      panY: camRef.current.panY,
    };
  }

  function onMouseUp() {
    isPanningRef.current = false;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const v = viewRef.current || { scale: 1, tx: 0, ty: 0 };
    const user = camRef.current;
    const wx = (mx - v.tx) / v.scale;
    const wy = (my - v.ty) / v.scale;
    const delta = -e.deltaY;
    const zoom = delta > 0 ? 1.08 : 1 / 1.08;
    user.scaleMul = clamp(user.scaleMul * zoom, 0.35, 6);
    const fit = fitRef.current;
    const newScale = fit.scale * user.scaleMul;
    user.panX = mx - fit.tx - wx * newScale;
    user.panY = my - fit.ty - wy * newScale;
    camRef.current = user;
    draw();
  }

  function onMouseMove(e) {
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      camRef.current = {
        ...camRef.current,
        panX: panStartRef.current.panX + dx,
        panY: panStartRef.current.panY + dy,
      };
      draw();
      hoverRef.current = null;
      hoverDrawHandleRef.current = null;
      updateHoverOverlay(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const n = hitTest(mx, my);
    const nextHover = n
      ? {
          x: mx,
          y: my,
          handle: n.handle,
          followers: n.followers,
          tweetCount: n.tweetCount,
          bio: n.bio,
          accountCreatedAt: n.accountCreatedAt,
        }
      : null;
    hoverRef.current = nextHover;
    if (!hoverRafScheduledRef.current) {
      hoverRafScheduledRef.current = true;
      requestAnimationFrame(() => {
        hoverRafScheduledRef.current = false;
        const nextHandle = hoverRef.current ? hoverRef.current.handle : null;
        if (hoverDrawHandleRef.current !== nextHandle) {
          hoverDrawHandleRef.current = nextHandle;
          drawRef.current();
        }
        updateHoverOverlay(hoverRef.current);
      });
    }
  }

  function onClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const n = hitTest(mx, my);
    if (!n) {
      setSelectedHandle(null);
      return;
    }
    setSelectedHandle(n.handle);
    if (manualEditMode && isPrivilegedEditor) {
      const targetHandle = normalizeHandle(n.handle);
      if (targetHandle && targetHandle === meHandleLower) {
        setManualEditError("Self-edit disabled in manual mode");
        return;
      }
      const account = accountByHandle.get(targetHandle) || null;
      const currentStance = normalizedStance(
        getStanceForHandle(labelsRef.current, targetHandle) || account?.stance || account?.position || n.seedStance || "neutral"
      );
      const base = getBase();
      const baseNoSlash = base.replace(/\/$/, "");
      const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
      setManualEditTarget({
        handle: targetHandle || n.handle,
        x_user_id: String(account?.x_user_id ?? "").trim(),
        followers_count: Number(account?.followers_count ?? n.followers ?? 0) || 0,
        avatar_url: account?.avatar_url || account?.profile_image_url || "",
        avatar_path: account?.avatar_path || "",
        avatarSrc: resolveAvatarUrlForAccount(account || { ...n, handle: targetHandle }, baseNoSlash, missingSrc),
        currentStance,
      });
      setManualEditChoice(currentStance);
      setManualEditError("");
      if (!import.meta.env.PROD) {
        // eslint-disable-next-line no-console
        console.log("[manual-edit] selected", {
          handle: targetHandle || n.handle,
          x_user_id: String(account?.x_user_id ?? ""),
          currentStance,
        });
      }
    }
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <div style={styles.title}>Consensus Health</div>
          <div style={styles.sub}>Loading data…</div>
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <div style={styles.title}>Consensus Health</div>
          <div style={styles.sub}>(local)</div>
        </div>
        <div style={styles.errBox}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Failed to load data files</div>
          <div style={{ whiteSpace: "pre-wrap" }}>{err}</div>
          <div style={{ marginTop: 12, opacity: 0.8 }}>
            Expected files:
            <div>/public/data/accounts_stanced.json</div>
            <div>/public/data/mentions_bip110.csv</div>
            Run: <code>powershell -ExecutionPolicy Bypass -File scripts\sync-data.ps1</code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div ref={headerRef} style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.brandWrap}>
            <div style={styles.title}>Consensus Health</div>
            <span style={styles.bipTag}>bip110</span>
          </div>
          <div style={styles.searchWrap}>
            <input
              className="appInput"
              style={styles.search}
              placeholder="Search @handle..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search.trim() !== "" && searchDropdownResults.length > 0 && (
              <div style={styles.searchDropdown}>
                {searchDropdownResults.map((handle) => (
                  <button
                    key={handle}
                    type="button"
                    style={{
                      ...styles.searchDropdownItem,
                      background: dropdownHoverHandle === handle ? "rgba(255,255,255,0.1)" : undefined,
                    }}
                    onClick={() => {
                      setSelectedHandle(handle);
                      setSearch("");
                    }}
                    onMouseEnter={() => setDropdownHoverHandle(handle)}
                    onMouseLeave={() => setDropdownHoverHandle(null)}
                  >
                    @{handle}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={styles.headerCenter}>
          {selectedHandle && (
            <>
              <div style={styles.selectedMetaBlock}>
                <img
                  src={selectedHeaderAvatarSrc}
                  alt={selectedHandle ? `@${selectedHandle}` : "selected user"}
                  loading="eager"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const fallback = missingAvatarSrcUrl();
                    if (canonicalAvatarSrc(e.currentTarget.src) !== fallback) e.currentTarget.src = fallback;
                  }}
                  style={styles.selectedHeaderAvatar}
                />
                <span
                  style={{ pointerEvents: "auto", userSelect: "text" }}
                  title="Open profile on X"
                >
                  <a
                    href={`https://x.com/${encodeURIComponent(selectedHandle)}`}
                    target="_blank"
                    rel="noreferrer"
                    style={styles.selectedHandleLink}
                  >
                    @{selectedHandle}
                  </a>
                </span>
                <span
                  style={{
                    ...styles.selectedStanceBadge,
                    color: stanceHeaderColor(selectedHeaderStance),
                    textShadow: `0 1px 0 rgba(0,0,0,0.9), 0 0 8px ${stanceHeaderColor(selectedHeaderStance)}, 0 0 18px ${stanceHeaderColor(selectedHeaderStance)}`,
                  }}
                >
                  {selectedHeaderStance || "unlabeled"}
                </span>
              </div>
            </>
          )}
        </div>
        <div style={styles.controls}>
          <div style={styles.accountBar}>
          <div ref={adminOptionsRef} style={styles.optionsWrap}>
            <button
              type="button"
              className="toolbarBtn"
              onClick={() => setAdminOptionsOpen((v) => !v)}
              disabled={Boolean(me?.authenticated) && authBusy}
              title="Options"
              aria-haspopup="menu"
              aria-expanded={adminOptionsOpen}
            >
              Options
            </button>
            {adminOptionsOpen && (
              <div style={styles.optionsMenu}>
                <label style={styles.optionsItem}>
                  <input
                    type="checkbox"
                    checked={equalAvatarSizeEnabled}
                    onChange={(e) => {
                      const v = e.target.checked;
                      if (v) {
                        stopHistoryPlayback();
                      }
                      setEqualAvatarSizePreference(v);
                    }}
                  />
                  <span>Equal avatar size</span>
                  <span style={styles.optionsState}>{equalAvatarSizeEnabled ? "ON" : "OFF"}</span>
                </label>
                {isPrivilegedEditor && (
                  <label style={styles.optionsItem}>
                    <input
                      type="checkbox"
                      checked={manualEditMode}
                      onChange={(e) => {
                        const v = e.target.checked;
                        if (v) {
                          stopHistoryPlayback();
                        }
                        setManualEditMode(v);
                      }}
                    />
                    <span>Edit stances</span>
                    <span style={styles.optionsState}>{manualEditMode ? "ON" : "OFF"}</span>
                  </label>
                )}
                <label style={styles.optionsItem}>
                  <input
                    type="checkbox"
                    checked={plebsMode}
                    onChange={(e) => {
                      const v = e.target.checked;
                      if (v) {
                        stopHistoryPlayback();
                        setInfluencersMode(false);
                      }
                      setPlebsMode(v);
                    }}
                  />
                  <span>Plebs (&lt;3k followers)</span>
                  <span style={styles.optionsState}>{plebsMode ? "ON" : "OFF"}</span>
                </label>
                <label style={styles.optionsItem}>
                  <input
                    type="checkbox"
                    checked={influencersMode}
                    onChange={(e) => {
                      const v = e.target.checked;
                      if (v) {
                        stopHistoryPlayback();
                        setPlebsMode(false);
                      }
                      setInfluencersMode(v);
                    }}
                  />
                  <span>Influencers (&gt;3k followers)</span>
                  <span style={styles.optionsState}>{influencersMode ? "ON" : "OFF"}</span>
                </label>
              </div>
            )}
          </div>
          {!me?.authenticated ? (
            <>
              <div style={styles.barDivider} aria-hidden="true" />
              <button type="button" className="toolbarBtn toolbarBtn--primary" onClick={beginLogin}>
                <span style={styles.btnInline}>
                  <span>Login with</span>
                  <svg viewBox="0 0 24 24" aria-hidden="true" style={styles.xLogoIcon}>
                    <path
                      fill="currentColor"
                      d="M18.244 2h3.308l-7.227 8.26L22.82 22h-6.648l-5.204-6.807L4.99 22H1.68l7.73-8.835L1 2h6.816l4.704 6.231L18.244 2Zm-1.16 18h1.833L6.82 3.894H4.853L17.084 20Z"
                    />
                  </svg>
                </span>
              </button>
            </>
          ) : (
            <>
              <div style={styles.barDivider} aria-hidden="true" />
              <div style={styles.stanceSegment} role="group" aria-label="Set your stance">
                <button
                  type="button"
                  className={`stanceSeg stanceSeg--red ${meStance === "against" ? "is-active" : ""} ${stancePop === "against" ? "just-selected" : ""}`}
                  onClick={() => selectStance("against", "against")}
                  disabled={authBusy}
                  aria-pressed={meStance === "against"}
                  title="Against"
                >
                  Against
                </button>
                <button
                  type="button"
                  className={`stanceSeg stanceSeg--gray ${meStance === "neutral" ? "is-active" : ""} ${stancePop === "neutral" ? "just-selected" : ""}`}
                  onClick={() => selectStance("neutral", "neutral")}
                  disabled={authBusy}
                  aria-pressed={meStance === "neutral"}
                  title="Neutral"
                >
                  Neutral
                </button>
                <button
                  type="button"
                  className={`stanceSeg stanceSeg--green ${meStance === "approve" ? "is-active" : ""} ${stancePop === "approve" ? "just-selected" : ""}`}
                  onClick={() => selectStance("approve", "support")}
                  disabled={authBusy}
                  aria-pressed={meStance === "approve"}
                  title="Approve"
                >
                  Approve
                </button>
              </div>
              <div style={styles.barDivider} aria-hidden="true" />
              <div ref={profileMenuRef} style={styles.profileWrap}>
                <button
                  type="button"
                  className="avatarButton"
                  onClick={() => setProfileMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={profileMenuOpen}
                  aria-label={`Account menu for @${me.handle}`}
                  title={`@${me.handle}`}
                >
                  <img
                    src={meChipAvatarSrc}
                    alt={`@${me.handle}`}
                    loading="eager"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      const fallback = missingAvatarSrcUrl();
                      if (canonicalAvatarSrc(e.currentTarget.src) !== fallback) e.currentTarget.src = fallback;
                      if (!import.meta.env.PROD) {
                        // eslint-disable-next-line no-console
                        console.warn("[avatar-load-failed]", {
                          handle: normalizeHandle(me.handle),
                          avatarUrl: me.avatar_url || "",
                          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
                          onErrorFired: true,
                          placeholderFallbackUsed: true,
                        });
                      }
                    }}
                    style={styles.userChipAvatar}
                  />
                </button>
                {profileMenuOpen && (
                  <div style={styles.profileMenu} role="menu" aria-label="Account">
                    <div style={styles.profileMenuHandle}>@{me.handle}</div>
                    <div style={styles.optionsDivider} role="separator" />
                    <button
                      type="button"
                      className="optionsMenuAction"
                      role="menuitem"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        logout();
                      }}
                      disabled={authBusy}
                      title="Log out"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" style={styles.logoutIcon}>
                        <path
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15 12H4m0 0 4-4m-4 4 4 4M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"
                        />
                      </svg>
                      <span>Log out</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      <div
        style={{
          ...styles.main,
          ...(newStancesUi.bandActive
            ? {
                marginTop: -computeIntroBandLiftPx(headerHeightPx),
                position: "relative",
                zIndex: 12,
              }
            : null),
        }}
      >
        <div ref={containerRef} style={styles.canvasWrap}>
          {!stanceListsViewEnabled ? (
            <>
              {(newStancesUi.headingOpacity > 0.01 || newStancesUi.bandActive) && (
                <div
                  className="newStancesHeading"
                  style={{ opacity: newStancesUi.headingOpacity }}
                  aria-live="polite"
                >
                  {NEW_STANCES_HEADING}
                </div>
              )}
              {newStancesUi.debug && (
                <div className="newStancesDebugLabel">Debug new stances</div>
              )}
              <canvas
                ref={canvasRef}
                onWheel={onWheel}
                onMouseDown={onMouseDown}
                onMouseUp={onMouseUp}
                onMouseLeave={() => {
                  onMouseUp();
                  hoverRef.current = null;
                  hoverDrawHandleRef.current = null;
                  updateHoverOverlay(null);
                  drawRef.current();
                }}
                onMouseMove={onMouseMove}
                onClick={onClick}
                style={{
                  ...styles.canvas,
                  touchAction: "none",
                  cursor: manualEditMode && isPrivilegedEditor ? "crosshair" : "default",
                  pointerEvents: historyPlaybackPlaying ? "none" : "auto",
                }}
              />
              <div ref={tooltipRef} style={{ ...styles.tooltip, display: "none" }}>
                <div ref={tooltipHandleRef} style={{ fontWeight: 700 }} />
                <div ref={tooltipSelfRef} style={styles.tooltipSelf}>You</div>
                <div ref={tooltipFollowersRef} style={{ opacity: 0.9 }} />
                <div ref={tooltipAgeRef} style={styles.tooltipAge} />
                <div ref={tooltipBioRef} style={styles.tooltipBio} />
              </div>
            </>
          ) : stanceListLayout ? (
            <div
              style={{
                ...styles.stanceListsRoot,
                flexDirection: stanceListLayout.isNarrow ? "column" : "row",
              }}
            >
              {[
                { key: STANCE.AGAINST, title: "Against", color: "#ef4444" },
                { key: STANCE.NEUTRAL, title: "Neutral", color: "#cbd5e1" },
                { key: STANCE.APPROVE, title: "Approve", color: "#22c55e" },
              ].map(({ key, title, color }) => {
                const rows = stanceListRowsByStance[key] || [];
                const sel = selectedHandle ? normalizeHandle(selectedHandle) : "";
                const L = stanceListLayout;
                return (
                  <div
                    key={key}
                    style={{
                      ...styles.stanceListColumn,
                      flex: "1 1 0",
                      minWidth: 0,
                      minHeight: 0,
                    }}
                  >
                    <div
                      style={{
                        ...styles.stanceListHeader,
                        color,
                        minHeight: L.colHeader,
                        maxHeight: L.colHeader,
                        fontSize: L.headerFont,
                        padding: "4px 6px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxSizing: "border-box",
                      }}
                    >
                      {title}
                    </div>
                    <div
                      style={{
                        ...styles.stanceListScroll,
                        padding: `${Math.max(4, L.scrollPad * 0.5)}px ${L.scrollPad}px`,
                        overflowY: L.scrollOverflow,
                        display: "grid",
                        gridTemplateColumns: `repeat(${L.gridCols}, minmax(0, 1fr))`,
                        gridAutoRows: `${L.rowH}px`,
                        gap: L.cellGap,
                        alignContent: "start",
                      }}
                    >
                      {rows.map((row) => (
                        <button
                          key={row.normHandle}
                          type="button"
                          style={{
                            ...styles.stanceListHandleBtn,
                            height: L.rowH,
                            minHeight: L.rowH,
                            maxHeight: L.rowH,
                            fontSize: L.fontSize,
                            background:
                              sel === row.normHandle ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)",
                            borderColor: sel === row.normHandle ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.12)",
                          }}
                          title={`Open @${row.normHandle}`}
                          onClick={() => setSelectedHandle(row.handle)}
                        >
                          <img
                            src={row.avatarSrc}
                            alt=""
                            style={{
                              width: L.avatarPx,
                              height: L.avatarPx,
                              borderRadius: 999,
                              objectFit: "cover",
                              flexShrink: 0,
                              border: "1px solid rgba(255,255,255,0.2)",
                            }}
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              const fb = missingAvatarSrcUrl();
                              if (canonicalAvatarSrc(e.currentTarget.src) !== fb) e.currentTarget.src = fb;
                            }}
                          />
                          <span style={styles.stanceListHandleText}>@{row.normHandle}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
      <div style={styles.footerNote}>
        <div>Stances are self-reported or curated.</div>
        {stanceListsViewEnabled ? (
          <div>Within each stance: avatar + @username, multi-column grid, followers (highest first).</div>
        ) : equalAvatarSizeEnabled ? (
          <div>Equal-size avatars packed to fill the screen; each stance column&apos;s width reflects its number of users.</div>
        ) : (
          <div>Size of avatars is proportional to number of followers.</div>
        )}
      </div>
      <div style={styles.bottomControls}>
        <button type="button" className="toolbarBtn toolbarBtn--primary toolbarBtn--lg" onClick={openStatsModal}>Stats</button>
        <button type="button" className="toolbarBtn toolbarBtn--primary toolbarBtn--lg" onClick={() => setShowDonateModal(true)}>Donate</button>
        {stancePlaybackSequenceCount > 0 && !stanceListsViewEnabled ? (
          <button
            type="button"
            className="toolbarBtn toolbarBtn--primary toolbarBtn--lg"
            onClick={() => (historyPlaybackPlaying ? stopHistoryPlayback() : beginHistoryPlayback())}
          >
            {historyPlaybackPlaying ? "Stop" : historyPlaybackHasFinishedOnce ? "Replay History" : "Play History"}
          </button>
        ) : null}
      </div>
      {showStatsModal && (
        <Suspense fallback={null}>
          <StatisticsModal
            open={showStatsModal}
            onClose={() => setShowStatsModal(false)}
            data={statisticsData}
            loading={statsLoading && !statisticsData}
            error={statsError}
            apiBase={API_BASE}
            onRetryHistory={() => {
              statsFetchStartedAtRef.current = performance.now();
              fetchStats({ forceLoading: true });
            }}
          />
        </Suspense>
      )}
      {manualEditMode && isPrivilegedEditor && manualEditTarget && (
        <div style={styles.modalBackdrop} onClick={() => setManualEditTarget(null)}>
          <div style={styles.manualEditCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.manualEditTitle}>Manual stance edit</div>
            <div style={styles.manualEditRow}>
              <img
                src={manualEditTarget.avatarSrc}
                alt={`@${manualEditTarget.handle}`}
                loading="eager"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const fallback = missingAvatarSrcUrl();
                  if (canonicalAvatarSrc(e.currentTarget.src) !== fallback) e.currentTarget.src = fallback;
                }}
                style={styles.manualEditAvatar}
              />
              <div style={{ minWidth: 0 }}>
                <div style={styles.manualEditHandle}>@{manualEditTarget.handle}</div>
                <div style={styles.manualEditMeta}>Current: {manualEditTarget.currentStance || "neutral"}</div>
                <div style={styles.manualEditMeta}>Followers: {formatNum(manualEditTarget.followers_count || 0)}</div>
              </div>
            </div>
            <div style={styles.manualEditChoices}>
              {(["against", "neutral", "approve"]).map((stanceKey) => (
                <button
                  key={stanceKey}
                  className={`stanceGlow ${
                    stanceKey === "against" ? "stance-red" : stanceKey === "neutral" ? "stance-gray" : "stance-green"
                  } ${manualEditChoice === stanceKey ? (stanceKey === "against" ? "aura aura-red" : stanceKey === "neutral" ? "aura aura-gray" : "aura aura-green") : ""}`}
                  style={{
                    ...styles.pill,
                    opacity: manualEditChoice === stanceKey ? 1 : 0.72,
                    ...(manualEditChoice === stanceKey ? pillActiveStyle(stanceKey === "approve" ? "support" : stanceKey) : null),
                  }}
                  onClick={() => setManualEditChoice(stanceKey)}
                  disabled={manualEditBusy}
                >
                  {stanceKey === "approve" ? "Approve" : stanceKey === "against" ? "Against" : "Neutral"}
                </button>
              ))}
            </div>
            {manualEditError ? <div style={styles.manualEditErr}>{manualEditError}</div> : null}
            <div style={styles.manualEditFooter}>
              <button style={styles.btn} onClick={() => setManualEditTarget(null)} disabled={manualEditBusy}>
                Cancel
              </button>
              <button style={styles.btn} onClick={saveManualStanceEdit} disabled={manualEditBusy}>
                {manualEditBusy ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showDonateModal && (
        <div style={styles.modalBackdrop} onClick={() => setShowDonateModal(false)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <img
              src={donateAvatarSrc}
              alt="@zndtoshi"
              loading="eager"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={(e) => {
                const fallback = missingAvatarSrcUrl();
                if (canonicalAvatarSrc(e.currentTarget.src) !== fallback) e.currentTarget.src = fallback;
                if (!import.meta.env.PROD) {
                  // eslint-disable-next-line no-console
                  console.warn("[avatar-load-failed]", {
                    handle: "zndtoshi",
                    avatarUrl: donateAvatarSrc,
                    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
                    onErrorFired: true,
                    placeholderFallbackUsed: true,
                  });
                }
              }}
              style={styles.donateProfileAvatar}
            />
            <a href="https://x.com/zndtoshi" target="_blank" rel="noreferrer" style={styles.donateHandleLink}>
              @zndtoshi
            </a>
            {donationAddress ? (
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
                <Suspense fallback={<div style={{ width: 220, height: 220 }} />}>
                  <BitcoinQr value={`bitcoin:${donationAddress}`} size={220} />
                </Suspense>
              </div>
            ) : null}
            <div style={styles.donateAddr}>{donationAddress}</div>
            <button style={{ ...styles.btn, marginTop: 10 }} onClick={() => setShowDonateModal(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    height: "100vh",
    width: "100vw",
    display: "flex",
    flexDirection: "column",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
    background: "radial-gradient(ellipse 120% 100% at 50% 0%, #0f172a 0%, #020617 50%, #000 100%)",
    color: "#e2e8f0",
    overflow: "hidden",
  },
  header: {
    position: "relative",
    zIndex: 11,
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    background: "rgba(15,23,42,0.85)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 16 },
  brandWrap: { display: "flex", alignItems: "center", gap: 8 },
  bipTag: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.2,
    padding: "3px 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(17,24,39,0.72)",
    color: "#cbd5e1",
    textTransform: "lowercase",
  },
  searchWrap: { position: "relative" },
  searchDropdown: {
    position: "absolute",
    top: "100%",
    left: 0,
    marginTop: 4,
    minWidth: 260,
    maxHeight: 280,
    overflowY: "auto",
    background: "rgba(15,23,42,0.98)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 10,
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
    zIndex: 100,
    display: "flex",
    flexDirection: "column",
  },
  searchDropdownItem: {
    padding: "10px 12px",
    border: "none",
    background: "none",
    color: "#e2e8f0",
    fontSize: 13,
    fontWeight: 600,
    textAlign: "left",
    cursor: "pointer",
  },
  headerCenter: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 10,
    pointerEvents: "none",
  },
  selectedMetaBlock: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(15,23,42,0.62)",
  },
  selectedHeaderAvatar: {
    width: 30,
    height: 30,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,0.24)",
  },
  selectedHandle: { fontWeight: 800, fontSize: 14, color: "#e2e8f0" },
  selectedHandleLink: {
    ...{
      fontWeight: 900,
      fontSize: 15,
      color: "#f1f5f9",
    },
    textDecoration: "none",
    cursor: "pointer",
  },
  selectedStanceBadge: { fontWeight: 850, fontSize: 17, letterSpacing: 0.25, lineHeight: 1, textTransform: "capitalize" },
  title: { fontSize: 16, fontWeight: 900, letterSpacing: 0.2, color: "#e2e8f0" },
  stanceRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  stanceLabel: { fontSize: 12, opacity: 0.9, marginRight: 4 },
  userChip: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(30,41,59,0.65)",
  },
  userChipAvatar: {
    width: 24,
    height: 24,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,0.28)",
  },
  userChipStance: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: 0.3,
    color: "#cbd5e1",
  },
  controls: {
    position: "absolute",
    right: 16,
    top: 8,
    zIndex: 30,
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: "calc(100vw - 32px)",
  },
  // One cohesive floating toolbar surface that groups all account controls.
  accountBar: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: 4,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(17,24,39,0.72)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: "calc(100vw - 32px)",
  },
  // Subtle vertical separator between toolbar groups.
  barDivider: {
    width: 1,
    alignSelf: "stretch",
    minHeight: 22,
    margin: "2px 4px",
    background: "rgba(255,255,255,0.08)",
  },
  // Profile group: avatar + handle, no heavy outline of its own.
  profileGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
    padding: "0 6px",
  },
  profileHandle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#f1f5f9",
    whiteSpace: "nowrap",
    maxWidth: 140,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // Clickable avatar + its account dropdown, anchored at the far right.
  profileWrap: {
    position: "relative",
    display: "inline-flex",
  },
  profileMenu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    minWidth: 180,
    padding: 8,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(15,23,42,0.98)",
    boxShadow: "0 8px 22px rgba(0,0,0,0.35)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    zIndex: 120,
  },
  profileMenuHandle: {
    fontSize: 12,
    fontWeight: 800,
    color: "#f1f5f9",
    padding: "2px 6px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // Segmented stance control track (three equal-width cells).
  stanceSegment: {
    display: "inline-grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 3,
    padding: 3,
    borderRadius: 10,
    background: "rgba(0,0,0,0.28)",
    border: "1px solid rgba(255,255,255,0.06)",
  },
  optionsDivider: {
    height: 1,
    margin: "4px 2px",
    background: "rgba(255,255,255,0.08)",
  },
  search: {
    width: 260,
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(17,24,39,0.72)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    color: "#e2e8f0",
  },
  btn: {
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(30,41,59,0.8)",
    color: "#e2e8f0",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  optionsWrap: {
    position: "relative",
    display: "inline-flex",
  },
  optionsMenu: {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    minWidth: 240,
    padding: 8,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(15,23,42,0.98)",
    boxShadow: "0 8px 22px rgba(0,0,0,0.35)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    zIndex: 120,
  },
  optionsItem: {
    display: "grid",
    gridTemplateColumns: "16px 1fr auto",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: "#e2e8f0",
    padding: "6px 6px",
    borderRadius: 8,
    background: "rgba(255,255,255,0.02)",
  },
  optionsState: {
    fontSize: 11,
    fontWeight: 800,
    color: "rgba(255,255,255,0.75)",
  },
  manualEditBtnOff: {
    borderColor: "rgba(255,255,255,0.22)",
    background: "rgba(30,41,59,0.8)",
  },
  manualEditBtnOn: {
    borderColor: "rgba(251,191,36,0.85)",
    background: "rgba(251,191,36,0.18)",
    boxShadow: "0 0 0 1px rgba(251,191,36,0.35), 0 0 14px rgba(251,191,36,0.35)",
  },
  btnInline: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  xLogoIcon: {
    width: 12,
    height: 12,
    display: "inline-block",
  },
  logoutIcon: {
    width: 15,
    height: 15,
    display: "inline-block",
    flexShrink: 0,
    opacity: 0.85,
  },
  main: {
    flex: 1,
    minHeight: 0,
    width: "100vw",
    position: "relative",
    overflow: "hidden",
  },
  canvasWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    background: "transparent",
    overflow: "hidden",
  },
  canvas: { width: "100%", height: "100%", display: "block", cursor: "pointer" },
  stanceListsRoot: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "row",
    gap: "clamp(6px, 1vmin, 14px)",
    padding: "clamp(6px, 1.2vmin, 16px)",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  stanceListColumn: {
    flex: "1 1 0",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(15,23,42,0.55)",
    overflow: "hidden",
  },
  stanceListHeader: {
    fontWeight: 900,
    letterSpacing: 0.02,
    textAlign: "center",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    flexShrink: 0,
  },
  stanceListScroll: {
    flex: 1,
    minHeight: 0,
    overflowX: "hidden",
  },
  stanceListHandleBtn: {
    boxSizing: "border-box",
    margin: 0,
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.12)",
    color: "#e2e8f0",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
    fontWeight: 700,
    lineHeight: 1.2,
    cursor: "pointer",
    overflow: "hidden",
    padding: "0 5px 0 4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 6,
    textAlign: "left",
  },
  stanceListHandleText: {
    minWidth: 0,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tooltip: {
    position: "absolute",
    width: 220,
    padding: "10px 10px",
    borderRadius: 12,
    background: "rgba(15,23,42,0.92)",
    color: "#e2e8f0",
    border: "1px solid rgba(255,255,255,0.15)",
    pointerEvents: "none",
    fontSize: 12,
  },
  tooltipSelf: {
    display: "none",
    marginTop: 4,
    marginBottom: 2,
    fontSize: 11,
    fontWeight: 800,
    color: "#ffffff",
    padding: "2px 6px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.75)",
    background: "rgba(255,255,255,0.12)",
  },
  tooltipAge: {
    display: "none",
    marginTop: 4,
    opacity: 0.86,
  },
  tooltipBio: {
    display: "none",
    marginTop: 4,
    lineHeight: 1.3,
    opacity: 0.92,
    maxHeight: "3.9em",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  side: {
    borderLeft: "1px solid rgba(0,0,0,0.08)",
    background: "#fff",
    minHeight: 0,
    display: "flex",
  },
  sideEmpty: { padding: 16, fontSize: 13 },
  sideInner: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  sideTitle: {
    padding: 16,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    borderBottom: "1px solid rgba(0,0,0,0.08)",
  },
  xLink: { textDecoration: "none", fontWeight: 800, color: "#111" },
  tweets: { padding: 16, overflow: "auto", display: "flex", flexDirection: "column", gap: 10 },
  tweetCard: {
    border: "1px solid rgba(0,0,0,0.10)",
    borderRadius: 14,
    padding: 12,
    background: "#fff",
  },
  tweetMeta: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  tweetLink: { textDecoration: "none", fontWeight: 800, color: "#111" },
  tweetText: { marginTop: 8, fontSize: 13, lineHeight: 1.35 },
  footer: {
    padding: "10px 16px",
    fontSize: 12,
    opacity: 0.75,
    borderTop: "1px solid rgba(0,0,0,0.08)",
    background: "#fff",
  },
  errBox: {
    margin: 16,
    padding: 16,
    borderRadius: 14,
    border: "1px solid rgba(0,0,0,0.12)",
    background: "#fff",
    fontSize: 13,
  },
  pill: {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(30,41,59,0.8)",
    color: "#e2e8f0",
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 11,
  },
  textarea: {
    width: "100%",
    minHeight: 90,
    marginTop: 6,
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(0,0,0,0.15)",
    outline: "none",
    resize: "vertical",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    fontSize: 12,
  },
  footerNote: {
    position: "fixed",
    left: 12,
    bottom: 10,
    fontSize: 11,
    opacity: 0.65,
    pointerEvents: "none",
    zIndex: 20,
  },
  bottomControls: {
    position: "fixed",
    right: 18,
    bottom: 18,
    zIndex: 40,
    display: "flex",
    gap: 4,
    alignItems: "center",
    background: "rgba(17,24,39,0.72)",
    padding: 4,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.1)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  },
  bottomControlBtn: {
    height: 34,
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.25)",
    background: "rgba(30,41,59,0.86)",
    color: "#e2e8f0",
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 12,
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200,
  },
  modalCard: {
    width: "min(380px, 92vw)",
    padding: 14,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(15,23,42,0.97)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
  },
  manualEditCard: {
    width: "min(360px, 92vw)",
    padding: 14,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(15,23,42,0.97)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  manualEditTitle: {
    fontSize: 14,
    fontWeight: 900,
    color: "#e2e8f0",
  },
  manualEditRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  manualEditAvatar: {
    width: 48,
    height: 48,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,0.24)",
  },
  manualEditHandle: {
    fontSize: 13,
    fontWeight: 900,
    color: "#e2e8f0",
  },
  manualEditMeta: {
    fontSize: 12,
    color: "rgba(255,255,255,0.76)",
  },
  manualEditChoices: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  manualEditFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
  },
  manualEditErr: {
    fontSize: 12,
    color: "#fca5a5",
    fontWeight: 700,
  },
  donateProfileAvatar: {
    width: 64,
    height: 64,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,0.3)",
  },
  donateHandleLink: {
    color: "#93c5fd",
    fontWeight: 800,
    textDecoration: "none",
    fontSize: 13,
  },
  donateQr: {
    width: 260,
    maxWidth: "86vw",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "#fff",
  },
  donateAddr: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
    textAlign: "center",
    wordBreak: "break-all",
    color: "#e2e8f0",
  },
};
