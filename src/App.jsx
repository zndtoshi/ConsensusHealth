import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceManyBody, forceCenter, forceSimulation, forceX, forceY } from "d3-force";
import {
  canonicalAvatarSrc,
  getAvatar,
  getAvatarPrioritized,
  preloadAvatarUrls,
  setAvatarLoadConcurrency,
} from "./utils/avatarCache";
import {
  initPerfDebug,
  isPerfDebugEnabled,
  perfInc,
  perfMark,
  perfNowSinceNav,
  perfRecordDragFrame,
  perfSetMs,
  updatePerfOverlay,
} from "./utils/perfDebug";
import { isChromium, isFirefox } from "./utils/browser";
import { parseDebugGlowParams, resolveGlowProfile, scaleRgbaAlpha } from "./utils/glowRendering";
import { fetchCommunityUsers } from "./api/community";
import { applyManualStanceUpdate, isPrivilegedManualEditor } from "./utils/manualEditState";
import { layoutEqualSizeGrid } from "./utils/equalSizeGrid";
import { followersForAvatarSize } from "./utils/avatarSize";
import { formatXJoinDate } from "./utils/xJoinDate";
import {
  defaultJoinDateRange,
  filterAccountsByJoinDate,
  normalizeJoinYearRange,
  summarizeJoinDateYears,
} from "./utils/xJoinDateFilter";
import { layoutRestoreIsSufficient } from "./utils/layoutPositionRestore";
import { XJoinDateRangeSlider } from "./components/XJoinDateRangeSlider";
import { StanceChoiceCard } from "./components/StanceChoiceCard";
import { CuratedStanceInfo } from "./components/CuratedStanceInfo";
import {
  shouldAutoOpenStanceChoice,
  stanceChoiceMode,
  toolbarStanceMeta,
  userHasChosenStance,
} from "./utils/stanceChoice";
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
import { ENABLE_CLUSTER_HALO } from "./config/clusterHalo";
import { ENABLE_INFLUENCE_LAYOUT } from "./config/influenceLayout";
import {
  drawClusterHalos,
  shouldShowClusterHalo,
  snapClusterHaloState,
} from "./utils/clusterHalo";
import {
  INFLUENCE_LAYOUT_STANCE_ANCHOR_MUL,
  breathingHaloAlpha,
  breathingHaloPhaseOffsetMs,
  collisionRadiusMultiplier,
  computeFollowerInfluenceBounds,
  createForceInfluenceCenterBias,
  followerInfluence,
  seedInfluenceLayoutPosition,
  selectTopBreathingHaloHandles,
} from "./utils/influenceLayout";
import {
  introAvatarAriaLabel,
  introAvatarEntrance,
  introCountdownDotOpacity,
  introStanceAura,
  lockIntroSession,
  clearPlayingSession,
  computeFlightScreenPos,
  computeStagingLayouts,
  computeStagingPanelBounds,
  easeInOutCubic,
  getIntroPhase,
  headingOpacityForPhase,
  panelFlightExitDurationMs,
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
import {
  IntroFlightMotionProfiler,
  INTRO_FLIGHT_PERF_SAMPLE_MS,
  cancelWaapiFlight,
  flightDurationMs,
  parseDebugNewStancesMotionParams,
  readReducedMotionPreference,
  startWaapiFlightAnimation,
} from "./utils/newStancesFlight";

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
  // Prefer locally hosted avatar files (fast, static, cached).
  const path = String(a?.avatar_path ?? "").trim();
  if (path) {
    const rel = path.startsWith("/") ? path : `/${path}`;
    return canonicalAvatarSrc(`${baseNoSlash}${rel}?v=${AVATAR_REV}`);
  }
  const remote = firstNonEmptyAvatarField(a);
  if (remote) return canonicalAvatarSrc(maybeProxyAvatarUrl(remote));
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
const GLOW_CACHE_VERSION = 4;
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

// Persisted graph layout so a reload shows the settled positions instantly
// (no recompute, no fly-in animation). Keyed by a signature that captures
// everything the layout depends on: the exact node set + each node's stance and
// size, the viewport, and the layout-affecting modes.
// Bumped to v3 with the follower-influence layout rollout so previously cached
// production/experimental positions are recomputed with the refined layout.
const LAYOUT_CACHE_KEY = "consensushealth:layout:v3";

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

/** In-memory positions from the live graph — used when filters change the node set. */
function snapshotLayoutPositions(nodes) {
  const pos = {};
  for (const n of nodes || []) {
    const h = normalizeHandle(n.handle);
    if (h && Number.isFinite(n.x) && Number.isFinite(n.y)) {
      pos[h] = [n.x, n.y];
    }
  }
  return pos;
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function createGlowSprite(aura, side, emphasize, quality = 1, glowOpts = {}) {
  const blurMul = glowOpts.blurMultiplier ?? 1;
  const opacityMul = glowOpts.opacityMultiplier ?? 1;
  const glowAura = opacityMul === 1 ? aura : scaleRgbaAlpha(aura, opacityMul);
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
  const maxBlur = layers.reduce((m, l) => Math.max(m, l.blur * quality * blurMul), 0);
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
    g.shadowColor = glowAura;
    g.shadowBlur = layer.blur * quality * blurMul;
    g.strokeStyle = glowAura.replace(/[\d.]+\)$/, `${layer.alpha * opacityMul})`);
    g.lineWidth = layer.line;
    g.beginPath();
    drawRoundedRectPath(g, x, y, side, side, r);
    g.stroke();
  }
  g.shadowBlur = 0;
  g.shadowColor = "transparent";
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

// Selection highlight: the selected avatar grows to roughly a top-follower
// account's size and nudges nearby avatars outward to open a ring of space,
// reverting fully on deselect. Matches `sideFromFollowers` max (70).
const SELECTED_TARGET_SIDE = 70;
const SELECTED_GAP_PX = 8;
const SELECTED_FX_GROW_MS = 280;
const SELECTED_FX_SHRINK_MS = 240;

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
  const seededPromise = fetch(`${base}/data/accounts_stanced.json?v=${DATA_REV}`).then((r) =>
    r.ok ? r.json() : []
  );
  const communityPromise = fetchCommunityUsers().catch(() => []);

  // Wait for both sources before first paint so the graph does not briefly show
  // seed-only (~150) accounts and then jump to the full live community set.
  const [seeded, community] = await Promise.all([seededPromise, communityPromise]);
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

    const incomingPath = String(raw?.avatar_path ?? "").trim();
    if (incomingPath) {
      const currentPath = String(rec?.avatar_path ?? "").trim();
      if (!currentPath || source === "community") rec.avatar_path = incomingPath;
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

  const finalizeMerged = () => {
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
  };

  for (const a of Array.isArray(seeded) ? seeded : []) upsert(a, "seeded");
  for (const c of Array.isArray(community) ? community : []) upsert(c, "community");
  finalizeMerged();

  console.log(
    "[ConsensusHealth] loaded seeded:",
    Array.isArray(seeded) ? seeded.length : 0,
    "community:",
    Array.isArray(community) ? community.length : 0,
    "merged:",
    merged.length
  );
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
  const introCanvasRef = useRef(null);
  const introFlightLayerRef = useRef(null);
  const introHeadingRef = useRef(null);
  const introMotionDebugRef = useRef(null);
  const introGraphSnapshotRef = useRef({
    canvas: null,
    cw: 0,
    ch: 0,
    dpr: 0,
    active: false,
  });
  const containerRef = useRef(null);
  const { w, h } = useContainerSize(containerRef);
  const isFirefoxBrowser = useMemo(() => isFirefox(), []);
  const isChromiumBrowser = useMemo(() => isChromium(), []);
  const glowProfile = useMemo(() => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    return resolveGlowProfile({
      isFirefox: isFirefoxBrowser,
      isChromium: isChromiumBrowser,
      debugGlow: parseDebugGlowParams(search),
    });
  }, [isFirefoxBrowser, isChromiumBrowser]);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [accounts, setAccounts] = useState([]); // [{handle, followers_count, seed_follow_count, ...}]
  const [mentions, setMentions] = useState([]); // tweet rows
  const [selectedHandle, setSelectedHandle] = useState(null);
  const [search, setSearch] = useState("");
  const [me, setMe] = useState(null);
  const showClusterHalo = useMemo(
    () =>
      shouldShowClusterHalo({
        enabled: ENABLE_CLUSTER_HALO,
        authenticatedHandle: me?.authenticated ? me?.handle : null,
      }),
    [me?.authenticated, me?.handle]
  );
  // Follower-influence layout is the default for all visitors; the breathing
  // halo rides along with it (its motion is disabled under reduced motion at
  // draw time, so it can stay enabled here).
  const useInfluenceLayout = ENABLE_INFLUENCE_LAYOUT;
  const useBreathingHalo = ENABLE_INFLUENCE_LAYOUT;
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
  const [stanceChoiceOpen, setStanceChoiceOpen] = useState(false);
  /** Three scrollable stance columns (avatars + names) instead of force graph; mutually exclusive with Plebs / equal size / manual edit. */
  const [stanceListsViewEnabled, setStanceListsViewEnabled] = useState(false);
  const [plebsMode, setPlebsMode] = useState(false);
  const [influencersMode, setInfluencersMode] = useState(false);
  const [joinDateFilterEnabled, setJoinDateFilterEnabled] = useState(false);
  const [joinDateMinYear, setJoinDateMinYear] = useState(null);
  const [joinDateMaxYear, setJoinDateMaxYear] = useState(null);
  const [joinDateBoundMin, setJoinDateBoundMin] = useState(2006);
  const [joinDateBoundMax, setJoinDateBoundMax] = useState(() => new Date().getUTCFullYear());
  const joinDateRangeInitializedRef = useRef(false);
  const canvasWrapPulseRef = useRef(null);
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
    lastPhase: "idle",
    flightDomActive: false,
    graphFrozen: false,
    captureSnapshotPending: false,
    simplifiedEffects: false,
    motionDebug: false,
    motionProfiler: null,
    waapiHandles: [],
    headingOpacityCached: -1,
    panelExiting: false,
  });
  const meRef = useRef(null);
  const [newStancesUi, setNewStancesUi] = useState({
    headingOpacity: 0,
    debug: false,
    debugMotion: false,
    bandActive: false,
    ariaLabels: [],
  });
  const introPanelRef = useRef(null);
  const introCountdownRef = useRef(null);
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
    if (!me?.authenticated) return false;
    try {
      setAuthBusy(true);
      const res = await fetch(`${API_BASE}/api/stance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ stance }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data?.handle && data?.stance) {
        setLabels((prev) => ({ ...prev, [String(data.handle).toLowerCase()]: normalizedStance(data.stance) }));
        // Update only this user's node locally; never reload or refetch the graph.
        setAccounts((prev) => upsertSelfAccountLocally(prev, data));
      }
      await loadMe();
      return true;
    } finally {
      setAuthBusy(false);
    }
  }

  async function chooseStanceFromCard(uiStance, apiStance) {
    setStancePop(uiStance);
    if (stancePopTimerRef.current) clearTimeout(stancePopTimerRef.current);
    stancePopTimerRef.current = setTimeout(() => setStancePop(null), 240);
    const ok = await setMyStance(apiStance);
    if (ok) setStanceChoiceOpen(false);
  }

  useEffect(() => {
    if (!me?.authenticated) {
      setStanceChoiceOpen(false);
      return;
    }
    if (shouldAutoOpenStanceChoice(me)) {
      setStanceChoiceOpen(true);
    }
  }, [me?.authenticated, me?.stance, me?.x_user_id]);

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
  const meHasStance = userHasChosenStance(me);
  const meStanceToolbar = toolbarStanceMeta(meStance);
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

  const followerFilteredAccounts = useMemo(() => {
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

  const joinDateFilterActive =
    joinDateFilterEnabled && joinDateMinYear != null && joinDateMaxYear != null;

  const visibleAccounts = useMemo(() => {
    if (!joinDateFilterActive) return followerFilteredAccounts;
    return filterAccountsByJoinDate(
      followerFilteredAccounts,
      true,
      joinDateMinYear,
      joinDateMaxYear
    );
  }, [
    followerFilteredAccounts,
    joinDateFilterActive,
    joinDateMinYear,
    joinDateMaxYear,
  ]);

  const joinDateFilterStats = useMemo(() => {
    if (!joinDateFilterActive) {
      return { unknownHiddenCount: 0, showingCount: visibleAccounts.length, totalCount: accounts.length };
    }
    const summary = summarizeJoinDateYears(followerFilteredAccounts);
    return {
      unknownHiddenCount: summary.unknownCount,
      showingCount: visibleAccounts.length,
      totalCount: followerFilteredAccounts.length,
    };
  }, [
    joinDateFilterActive,
    followerFilteredAccounts,
    visibleAccounts.length,
    accounts.length,
  ]);

  // A follower-filtered subset is active; dataset-wide change stats don't match it.
  const followerFilterActive = plebsMode || influencersMode || joinDateFilterActive;

  const accountByHandle = useMemo(() => {
    const m = new Map();
    for (const a of visibleAccounts) {
      const h = normalizeHandle(a?.handle);
      if (!h) continue;
      m.set(h, a);
    }
    return m;
  }, [visibleAccounts]);
  const accountByHandleRef = useRef(new Map());
  accountByHandleRef.current = accountByHandle;
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
    if (!joinDateFilterActive) return;
    const el = canvasWrapPulseRef.current;
    if (!el) return;
    el.classList.add("canvasWrap--joinDatePulse", "is-fading");
    const t = window.setTimeout(() => {
      el.classList.remove("is-fading");
    }, 180);
    return () => window.clearTimeout(t);
  }, [joinDateFilterActive, joinDateMinYear, joinDateMaxYear, visibleAccounts.length]);

  function enableJoinDateFilter(nextEnabled) {
    if (nextEnabled) {
      stopHistoryPlayback();
      if (!joinDateRangeInitializedRef.current || joinDateMinYear == null || joinDateMaxYear == null) {
        const range = defaultJoinDateRange(accounts);
        setJoinDateBoundMin(range.boundMin);
        setJoinDateBoundMax(range.boundMax);
        setJoinDateMinYear(range.minYear);
        setJoinDateMaxYear(range.maxYear);
        joinDateRangeInitializedRef.current = true;
      }
      setJoinDateFilterEnabled(true);
      return;
    }
    setJoinDateFilterEnabled(false);
  }

  function onJoinDateRangeChange({ minYear, maxYear }) {
    const next = normalizeJoinYearRange(
      minYear,
      maxYear,
      joinDateBoundMin,
      joinDateBoundMax
    );
    setJoinDateMinYear(next.minYear);
    setJoinDateMaxYear(next.maxYear);
  }

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

  // Gentle cluster-halo breathing repaint — skip while intro is frozen or the
  // camera is being dragged (pan uses a static layer instead).
  useEffect(() => {
    if (!showClusterHalo || stanceListsViewEnabled) return;
    let raf = 0;
    const tick = () => {
      if (!newStancesIntroRef.current.graphFrozen && !cameraInteractingRef.current) {
        drawRef.current();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [showClusterHalo, stanceListsViewEnabled]);

  // Top-account breathing halo repaint — skip while dragging.
  useEffect(() => {
    if (!useBreathingHalo || stanceListsViewEnabled || readReducedMotionPreference()) return;
    let raf = 0;
    const tick = () => {
      if (!newStancesIntroRef.current.graphFrozen && !cameraInteractingRef.current) {
        drawRef.current();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [useBreathingHalo, stanceListsViewEnabled]);

  // Opt-in performance overlay (?debugPerformance=1).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!initPerfDebug(window.location.search)) return;
    setAvatarLoadConcurrency(12);
    let raf = 0;
    const tick = () => {
      updatePerfOverlay([
        `settling=${layoutSettlingRef.current ? 1 : 0} camDrag=${cameraInteractingRef.current ? 1 : 0}`,
        `panLayer=${panLayerRef.current.valid ? 1 : 0} dpr=${window.devicePixelRatio || 1}`,
      ]);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Load canonical accounts from public/data + /api/community at mount.
  // Both sources are awaited before the first paint so the graph does not
  // briefly show seed-only accounts and then expand to the full live set.
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
        const apiStarted = performance.now();
        perfMark("accounts-load-start");
        const cleanedAccounts = await loadAccounts();
        if (dead) return;
        const accountsFiltered = cleanedAccounts.filter((r) => (r.handle ?? "").toString().trim().length > 0);
        perfSetMs("lastApiMs", performance.now() - apiStarted);
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

  // Preload avatars once accounts are available. Priority 1: missing placeholder +
  // largest accounts (likely initially visible). Priority 2: the rest. Bounded
  // concurrency lives in avatarCache — never await the full set before painting.
  useEffect(() => {
    if (!visibleAccounts.length) return;
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    preloadAvatarUrls([missingSrc], { priority: 0 });
    const ranked = [...visibleAccounts].sort(
      (a, b) => (Number(b.followers_count) || 0) - (Number(a.followers_count) || 0)
    );
    const priority1 = ranked.slice(0, 24).map((a) => resolveAvatarUrlForAccount(a, baseNoSlash, missingSrc));
    const priority2 = ranked.slice(24).map((a) => resolveAvatarUrlForAccount(a, baseNoSlash, missingSrc));
    preloadAvatarUrls(priority1, { priority: 10 });
    preloadAvatarUrls(priority2, { priority: 60 });
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
  // True while the user is actively panning/pinching — skips continuous halo RAF,
  // freezes fit, and enables the fast pan-layer blit path.
  const cameraInteractingRef = useRef(false);
  // Screen-space snapshot of the graph (no starfield) captured at interaction start.
  const panLayerRef = useRef({
    canvas: null,
    valid: false,
    panX: 0,
    panY: 0,
    scaleMul: 1,
    dpr: 1,
    cw: 0,
    ch: 0,
  });
  const suppressStarfieldRef = useRef(false);
  const canvasRectRef = useRef(null);
  const worldLayerVersionRef = useRef(0);
  const cameraInteractApiRef = useRef({
    begin: () => {},
    end: () => {},
    scheduleDraw: () => {},
    invalidatePanLayer: () => {},
  });

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
  // Touch gesture state (mobile). Integrates with the same camRef transform used
  // by desktop mouse/wheel — no separate camera system.
  const touchStateRef = useRef({
    mode: "none", // "pan" | "pinch"
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    startDist: 0,
    startScaleMul: 1,
    midWorldX: 0,
    midWorldY: 0,
    moved: false,
  });
  // Always-latest tap handler so once-mounted native touch listeners can open the
  // correct popup (and honor manual-edit mode) without stale closures.
  const selectAtPointRef = useRef(null);
  // Admin-only selection highlight FX state (enlarge selected + push neighbors).
  const selectionFxRef = useRef({
    handle: null,
    node: null,
    targetScale: 1,
    scale: 1,
    u: 0,
    fromU: 0,
    toU: 0,
    dur: 0,
    startAt: 0,
    rafId: 0,
    displaced: [],
  });
  // Cached fit transform, frozen while the selection FX runs so the whole graph
  // does not visibly rescale as neighbors are nudged.
  const frozenFitRef = useRef(null);
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
  const clusterHaloCacheRef = useRef(new Map());
  const clusterHaloSmoothRef = useRef({});
  const clusterHaloBreathEpochRef = useRef(null);
  const clusterHaloResumeSnapRef = useRef(false);
  const breathingHaloHandlesRef = useRef(new Set());
  const introBandLiftReleasePendingRef = useRef(false);
  labelsRef.current = labels;
  selectedHandleRef.current = selectedHandle;

  // --- Selection highlight FX (enlarge selected + push neighbors into orbit) ---
  function restoreSelectionDisplacementImmediate() {
    const fx = selectionFxRef.current;
    for (const d of fx.displaced) {
      d.node.x = d.ox;
      d.node.y = d.oy;
    }
    fx.displaced = [];
  }

  function computeSelectionDisplacement(node) {
    const nodes = nodesRef.current || [];
    const targetHalf = SELECTED_TARGET_SIDE / 2;
    // Mirror the force-sim collision radius so the ring of space matches what a
    // real top-follower account carves out (diagonal bounding circle + the max
    // influence multiplier), plus a small extra orbit gap.
    const selectedCollideR =
      (Math.SQRT2 * targetHalf + 0.6) * collisionRadiusMultiplier(1);
    const out = [];
    for (const m of nodes) {
      if (m === node) continue;
      const dx0 = m.x - node.x;
      const dy0 = m.y - node.y;
      let dist = Math.hypot(dx0, dy0);
      const mHalf = m.half || m.side / 2 || 0;
      const mCollideR = Math.SQRT2 * mHalf + 0.6;
      const desired = selectedCollideR + mCollideR + SELECTED_GAP_PX;
      if (dist >= desired) continue;
      let ux;
      let uy;
      if (dist < 1e-3) {
        const ang = Math.random() * Math.PI * 2;
        ux = Math.cos(ang);
        uy = Math.sin(ang);
        dist = 0;
      } else {
        ux = dx0 / dist;
        uy = dy0 / dist;
      }
      const push = desired - dist;
      out.push({ node: m, ox: m.x, oy: m.y, dx: ux * push, dy: uy * push });
    }
    return out;
  }

  function applySelectionU(u) {
    const fx = selectionFxRef.current;
    for (const d of fx.displaced) {
      d.node.x = d.ox + d.dx * u;
      d.node.y = d.oy + d.dy * u;
    }
    fx.u = u;
    fx.scale = 1 + (fx.targetScale - 1) * u;
  }

  function selectionFxTick() {
    const fx = selectionFxRef.current;
    const now = performance.now();
    const t = fx.dur > 0 ? clamp((now - fx.startAt) / fx.dur, 0, 1) : 1;
    const eased = 1 - (1 - t) ** 3; // ease-out cubic
    applySelectionU(fx.fromU + (fx.toU - fx.fromU) * eased);
    drawRef.current();
    if (t >= 1) {
      fx.rafId = 0;
      if (fx.toU <= 0) {
        restoreSelectionDisplacementImmediate();
        fx.handle = null;
        fx.node = null;
        fx.scale = 1;
        fx.u = 0;
        drawRef.current();
      }
      return;
    }
    fx.rafId = requestAnimationFrame(selectionFxTick);
  }

  function animateSelectionTo(toU, durMs) {
    const fx = selectionFxRef.current;
    if (fx.rafId) cancelAnimationFrame(fx.rafId);
    fx.fromU = fx.u;
    fx.toU = toU;
    fx.dur = durMs;
    fx.startAt = performance.now();
    fx.rafId = requestAnimationFrame(selectionFxTick);
  }

  function beginSelectionGrow(node) {
    const fx = selectionFxRef.current;
    if (fx.handle && fx.node && fx.node !== node) {
      // Switching selection: drop the previous ring before opening a new one.
      restoreSelectionDisplacementImmediate();
      fx.u = 0;
      fx.scale = 1;
    }
    fx.handle = node.handle;
    fx.node = node;
    fx.targetScale = Math.max(1, SELECTED_TARGET_SIDE / Math.max(1, node.side || 1));
    fx.displaced = computeSelectionDisplacement(node);
    animateSelectionTo(1, SELECTED_FX_GROW_MS);
  }

  // Re-apply the highlight after the layout rebuilds or resizes (common on mobile
  // where the viewport/address bar changes `w`/`h`, which rebuilds the node array
  // and would otherwise drop the enlarge + neighbor orbit). Idempotent: restores
  // any prior displacement first, then recomputes against the current nodes and
  // snaps straight to the grown state (no re-pop).
  function reapplySelectionFxAfterLayout() {
    const fx = selectionFxRef.current;
    if (fx.rafId) {
      cancelAnimationFrame(fx.rafId);
      fx.rafId = 0;
    }
    restoreSelectionDisplacementImmediate();
    const handle = selectedHandleRef.current;
    if (!handle) {
      fx.handle = null;
      fx.node = null;
      fx.u = 0;
      fx.scale = 1;
      return;
    }
    if (layoutSettlingRef.current || historyPlaybackRef.current?.active) {
      // Keep `selectedHandle`; the next layout-complete/resize pass re-applies.
      return;
    }
    const nodes = nodesRef.current || [];
    const node = nodes.find((n) => normalizeHandle(n.handle) === normalizeHandle(handle));
    if (!node) {
      fx.handle = null;
      fx.node = null;
      fx.u = 0;
      fx.scale = 1;
      return;
    }
    fx.handle = node.handle;
    fx.node = node;
    fx.targetScale = Math.max(1, SELECTED_TARGET_SIDE / Math.max(1, node.side || 1));
    fx.displaced = computeSelectionDisplacement(node);
    applySelectionU(1);
    drawRef.current();
  }

  function beginSelectionShrink() {
    const fx = selectionFxRef.current;
    if (!fx.handle) return;
    animateSelectionTo(0, SELECTED_FX_SHRINK_MS);
  }

  function clearSelectionFxImmediate() {
    const fx = selectionFxRef.current;
    if (fx.rafId) {
      cancelAnimationFrame(fx.rafId);
      fx.rafId = 0;
    }
    if (fx.handle || fx.displaced.length) {
      restoreSelectionDisplacementImmediate();
      fx.handle = null;
      fx.node = null;
      fx.u = 0;
      fx.scale = 1;
      drawRef.current();
    }
  }

  useEffect(() => {
    // Avoid fighting the playback/settle animations for node positions.
    if (layoutSettlingRef.current || historyPlaybackRef.current?.active) {
      return;
    }
    const norm = (h) => normalizeHandle(h);
    if (selectedHandle) {
      const nodes = nodesRef.current || [];
      const target = norm(selectedHandle);
      const node = nodes.find((n) => norm(n.handle) === target);
      if (node) beginSelectionGrow(node);
      else clearSelectionFxImmediate();
    } else {
      beginSelectionShrink();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHandle]);

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
    const prevPos = snapshotLayoutPositions(nodesRef.current);
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
        const followerInfo = getFollowersFromUser(a);
        const followersForSize = followersForAvatarSize(followerInfo, Boolean(seedStance));
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
          followers: followerInfo.followers,
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

    if (useInfluenceLayout && !equalAvatarSizeEnabled) {
      const regionsPreview = computeStanceRegions(nodes, labelsRef.current, w);
      const previewCenterX = regionsPreview
        ? (d) => regionsPreview.stanceCenterX[getNodeStance(d, labelsRef.current)] ?? w / 2
        : () => w / 2;
      for (const n of nodes) {
        seedInfluenceLayoutPosition(n, previewCenterX(n), h);
      }
    }

    nodesRef.current = nodes;
    hoverDrawHandleRef.current = null;

    if (useInfluenceLayout && !equalAvatarSizeEnabled) {
      breathingHaloHandlesRef.current = selectTopBreathingHaloHandles(
        nodes,
        (n) => getNodeStance(n, labelsRef.current)
      );
    } else {
      breathingHaloHandlesRef.current = new Set();
    }

    // Preload avatar images for visible nodes (priority by followers; progressive paint).
    const cache = avatarCacheRef.current;
    const warnedHandles = avatarWarnedHandlesRef.current;
    const hooked = avatarHookedRef.current;
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
    const urlToHandles = new Map();
    for (const n of nodes) {
      if (!n.avatarUrl) continue;
      const key = canonicalAvatarSrc(n.avatarUrl);
      if (!urlToHandles.has(key)) urlToHandles.set(key, []);
      urlToHandles.get(key).push(n.handle);
    }
    const missingImg = getAvatarPrioritized(missingSrc, 0);
    if (!hooked.has(missingImg)) {
      hooked.add(missingImg);
      missingImg.addEventListener("load", () => {
        invalidatePanLayer();
        scheduleDraw();
      });
    }
    const rankedNodes = [...nodes].sort((a, b) => (b.followers || 0) - (a.followers || 0));
    const seenUrl = new Set();
    rankedNodes.forEach((n, idx) => {
      if (!n.avatarUrl) return;
      const key = canonicalAvatarSrc(n.avatarUrl);
      if (seenUrl.has(key)) return;
      seenUrl.add(key);
      const priority = idx < 24 ? 10 : 60;
      const img = getAvatarPrioritized(key, priority);
      cache.set(key, img);
      if (!hooked.has(img)) {
        hooked.add(img);
        const handleError = (onErrorFired = true) => {
          const handles = urlToHandles.get(key) || [];
          for (const handle of handles) {
            if (warnedHandles.has(handle)) continue;
            warnedHandles.add(handle);
            if (!import.meta.env.PROD) {
              // eslint-disable-next-line no-console
              console.warn("[avatar-load-failed]", {
                handle,
                avatarUrl: key,
                userAgent,
                onErrorFired,
                placeholderFallbackUsed: true,
              });
            }
          }
          cache.set(key, missingImg);
          invalidatePanLayer();
          scheduleDraw();
        };
        img.addEventListener("load", () => {
          invalidatePanLayer();
          scheduleDraw();
        });
        img.addEventListener("error", () => handleError(true));
        // A brand-new Image() is `complete` with naturalWidth 0 before `src` is
        // assigned by the load queue — do not treat that as a failed load.
        const srcStarted = Boolean(img.getAttribute("data-ch-src") === "1" || img.src);
        if (srcStarted && img.complete) {
          if (img.naturalWidth > 0) {
            invalidatePanLayer();
            scheduleDraw();
          } else handleError(false);
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
      invalidatePanLayer();
      draw();
      reapplySelectionFxAfterLayout();
      tryStartNewStancesIntro();
      return () => {};
    }

    // Proportional stance regions (weight = sum sqrt(followers) per stance)
    const regions = computeStanceRegions(nodes, labelsRef.current, w);
    regionRef.current = regions;

    const stanceCenterX = regions
      ? (d) => regions.stanceCenterX[getNodeStance(d, labelsRef.current)] ?? w / 2
      : () => w / 2;

    const influenceBounds = useInfluenceLayout
      ? computeFollowerInfluenceBounds(nodes)
      : null;
    const getNodeInfluence = (d) =>
      influenceBounds
        ? followerInfluence(d.followers ?? 0, influenceBounds.minLog, influenceBounds.maxLog)
        : 0;
    const baseAnchorStrength = plebsMode
      ? (isFirefoxBrowser ? 0.01 : 0.013)
      : (isFirefoxBrowser ? 0.012 : 0.016);
    const anchorStrength = useInfluenceLayout
      ? baseAnchorStrength * INFLUENCE_LAYOUT_STANCE_ANCHOR_MUL
      : baseAnchorStrength;

    const sim = forceSimulation(nodes)
      .alpha(1)
      .alphaDecay(0.08)
      .velocityDecay(0.4)
      .force("center", forceCenter(w / 2, h / 2))
      // Plebs mode uses denser per-stance blobs by relaxing hard X bounds and using slightly stronger packing.
      .force("stanceX", forceX(stanceCenterX).strength(plebsMode ? 0.075 : 0.11))
      .force("stanceAnchor", forceStanceAnchor(regionRef, labelsRef, anchorStrength))
      .force("stanceBounds", plebsMode ? null : forceStanceBounds(regionRef, labelsRef, 0.07))
      .force("pullY", forceY(h / 2).strength(plebsMode ? 0.06 : 0.03))
      .force("charge", forceManyBody().strength(plebsMode ? -6 : -4))
      .force(
        "collide",
        forceCollide((d) => {
          const base = Math.sqrt(2) * d.half + 0.6;
          if (!useInfluenceLayout || !influenceBounds) return base;
          const inf = getNodeInfluence(d);
          return base * collisionRadiusMultiplier(inf);
        }).iterations(plebsMode ? 3 : 2)
      );

    if (useInfluenceLayout) {
      sim.force(
        "influenceCenter",
        createForceInfluenceCenterBias(
          () => regionRef.current,
          () => labelsRef.current,
          (node, labelsMap) => getNodeStance(node, labelsMap),
          getNodeInfluence,
          h
        )
      );
    } else {
      sim.force("influenceCenter", null);
    }

    simRef.current = sim;
    sim.stop(); // static layout: we compute final positions once, then never move

    sim.on("tick", () => {
      draw();
      if (sim.alpha() < 0.01) sim.stop();
    });

    // Fast path: restore the previously settled positions from cache so the graph
    // appears in its FINAL layout immediately on reload — no simulation at all.
    const layoutSig = computeLayoutSignature(
      nodes,
      labelsRef.current,
      w,
      h,
      plebsMode,
      equalAvatarSizeEnabled
    );
    const cachedPos = loadLayoutPositions(layoutSig);
    let restored = cachedPos ? applyLayoutPositions(nodes, cachedPos) : 0;
    // Filters (e.g. X join date) change the node set and miss the layout cache.
    // Reuse the previous on-screen positions so remaining avatars do not jump.
    if (!layoutRestoreIsSufficient(nodes.length, restored) && Object.keys(prevPos).length) {
      restored = applyLayoutPositions(nodes, prevPos);
    }
    const cacheHit = layoutRestoreIsSufficient(nodes.length, restored);

    // Cancel any settle still in flight from a previous effect run so we never
    // have two simulations driving the same nodes at once.
    if (settleRafRef.current) {
      cancelAnimationFrame(settleRafRef.current);
      settleRafRef.current = 0;
    }

    if (cacheHit) {
      // Previously settled positions restored from cache or the prior live graph:
      // paint immediately. No simulation, no delay.
      saveLayoutPositions(layoutSig, nodes);
      layoutSettlingRef.current = false;
      invalidatePanLayer();
      draw();
      reapplySelectionFxAfterLayout();
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
      if (useInfluenceLayout) {
        seedInfluenceLayoutPosition(n, stanceCenterX(n), h);
      } else {
        n.x = stanceCenterX(n) + (Math.random() - 0.5) * 60;
        n.y = h / 2 + (Math.random() - 0.5) * Math.min(h * 0.5, 400);
        n.vx = 0;
        n.vy = 0;
      }
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
      invalidatePanLayer();
      draw(); // single paint of the fully-settled layout
      reapplySelectionFxAfterLayout();
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
  }, [loading, err, visibleAccounts.length, w, h, plebsMode, equalAvatarSizeEnabled, stanceListsViewEnabled, useInfluenceLayout]);

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
    reapplySelectionFxAfterLayout();
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
    const joinDate = formatXJoinDate(nextHover.accountCreatedAt);
    if (tooltipAgeRef.current) {
      tooltipAgeRef.current.style.display = joinDate ? "block" : "none";
      tooltipAgeRef.current.textContent = joinDate;
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
    const key = `${cw}x${ch}|${dpr}|${isFirefoxBrowser ? "ff" : "std"}`;
    if (starfieldCanvasRef.current && starfieldKeyRef.current === key) return starfieldCanvasRef.current;
    const off = document.createElement("canvas");
    off.width = Math.floor(cw * dpr);
    off.height = Math.floor(ch * dpr);
    const sctx = off.getContext("2d");
    if (sctx) {
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.clearRect(0, 0, cw, ch);
      sctx.fillStyle = "rgba(255,255,255,0.4)";
      const starCount = isFirefoxBrowser ? 48 : 120;
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
  // cached avatar images all resolving their `load` handlers at once — and for
  // pointermove pan/pinch so we never draw more than once per animation frame.
  function scheduleDraw() {
    if (drawRafRef.current) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = 0;
      drawRef.current();
    });
  }

  function invalidatePanLayer() {
    panLayerRef.current.valid = false;
    worldLayerVersionRef.current += 1;
  }

  function refreshCanvasRect() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    canvasRectRef.current = canvas.getBoundingClientRect();
    return canvasRectRef.current;
  }

  function buildPanLayer() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const layer = panLayerRef.current;
    layer.valid = false;
    if (!layer.canvas) layer.canvas = document.createElement("canvas");
    const rawDpr = window.devicePixelRatio || 1;
    const dpr = isFirefoxBrowser ? Math.min(rawDpr, 1.5) : rawDpr;
    const cw = Math.max(1, w);
    const ch = Math.max(1, h);
    const bw = Math.floor(cw * dpr);
    const bh = Math.floor(ch * dpr);
    if (layer.canvas.width !== bw || layer.canvas.height !== bh) {
      layer.canvas.width = bw;
      layer.canvas.height = bh;
    }
    // Paint graph content (no starfield) onto the main canvas, copy into the
    // pan layer, then restore a full frame with starfield.
    suppressStarfieldRef.current = true;
    cameraInteractingRef.current = false; // force full content path
    draw();
    const lctx = layer.canvas.getContext("2d");
    if (lctx) {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, bw, bh);
      lctx.drawImage(canvas, 0, 0);
    }
    suppressStarfieldRef.current = false;
    layer.panX = camRef.current.panX;
    layer.panY = camRef.current.panY;
    layer.scaleMul = camRef.current.scaleMul;
    layer.dpr = dpr;
    layer.cw = cw;
    layer.ch = ch;
    layer.valid = true;
    if (isPerfDebugEnabled()) perfInc("worldLayerBuilds");
    cameraInteractingRef.current = true;
    draw(); // restore starfield under the current view
  }

  function beginCameraInteraction() {
    if (cameraInteractingRef.current) return;
    refreshCanvasRect();
    cameraInteractingRef.current = true;
    hoverRef.current = null;
    hoverDrawHandleRef.current = null;
    updateHoverOverlay(null);
    buildPanLayer();
  }

  function endCameraInteraction() {
    if (!cameraInteractingRef.current) return;
    cameraInteractingRef.current = false;
    invalidatePanLayer();
    scheduleDraw();
  }

  cameraInteractApiRef.current = {
    begin: beginCameraInteraction,
    end: endCameraInteraction,
    scheduleDraw,
    invalidatePanLayer,
  };

  function resolveDrawAvatarUrl(n) {
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    const account = accountByHandleRef.current.get(normalizeHandle(n.handle));
    if (account) return resolveAvatarUrlForAccount(account, baseNoSlash, missingSrc);
    const fallback = String(n?.avatarUrl ?? "").trim();
    return fallback ? canonicalAvatarSrc(fallback) : missingSrc;
  }

  function resolveIntroAvatarUrl(item) {
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);
    const account = accountByHandleRef.current.get(normalizeHandle(item.handle));
    if (account) return resolveAvatarUrlForAccount(account, baseNoSlash, missingSrc);
    const fallback = String(item?.avatarUrl ?? "").trim();
    return fallback ? canonicalAvatarSrc(fallback) : missingSrc;
  }

  function getGraphAvatar(url) {
    const key = canonicalAvatarSrc(String(url ?? "").trim());
    if (!key) return null;
    const cache = avatarCacheRef.current;
    let img = cache.get(key);
    if (!img) {
      img = getAvatar(key);
      cache.set(key, img);
    }
    const hooked = avatarHookedRef.current;
    if (!hooked.has(img)) {
      hooked.add(img);
      img.addEventListener("load", () => scheduleDraw());
      img.addEventListener("error", () => scheduleDraw());
      if (img.complete) scheduleDraw();
    }
    return img;
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

  function syncHeadingOpacity(opacity) {
    const intro = newStancesIntroRef.current;
    const clamped = Math.max(0, Math.min(1, opacity));
    if (intro.headingOpacityCached === clamped) return;
    intro.headingOpacityCached = clamped;
    const el = introHeadingRef.current;
    if (el) el.style.opacity = String(clamped);
  }

  function releaseGraphSnapshot() {
    const snap = introGraphSnapshotRef.current;
    snap.active = false;
    const intro = newStancesIntroRef.current;
    intro.graphFrozen = false;
    clusterHaloResumeSnapRef.current = true;
  }

  function captureGraphSnapshot(cw, ch, dpr) {
    clusterHaloBreathEpochRef.current = performance.now();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snap = introGraphSnapshotRef.current;
    if (!snap.canvas) snap.canvas = document.createElement("canvas");
    const sw = Math.floor(cw * dpr);
    const sh = Math.floor(ch * dpr);
    if (snap.canvas.width !== sw || snap.canvas.height !== sh) {
      snap.canvas.width = sw;
      snap.canvas.height = sh;
    }
    snap.cw = cw;
    snap.ch = ch;
    snap.dpr = dpr;
    const sctx = snap.canvas.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.drawImage(canvas, 0, 0);
    snap.active = true;
    newStancesIntroRef.current.graphFrozen = true;
  }

  function cleanupFlightDom() {
    const intro = newStancesIntroRef.current;
    if (intro.waapiHandles?.length) {
      cancelWaapiFlight(intro.waapiHandles);
      intro.waapiHandles = [];
    }
    const layer = introFlightLayerRef.current;
    if (layer) layer.replaceChildren();
    intro.flightDomActive = false;
    intro.motionProfiler = null;
  }

  function onFlightAvatarLanded(xUserId) {
    const intro = newStancesIntroRef.current;
    if (!intro.active) return;
    const item = intro.items.find((it) => it.xUserId === xUserId);
    if (!item || item.landed) return;
    item.landed = true;
    intro.landedIds.add(xUserId);
    if (item.handle) intro.landedHandles.add(normalizeHandle(item.handle));
    scheduleDraw();
    if (intro.items.every((it) => it.landed)) {
      cleanupFlightDom();
      releaseGraphSnapshot();
      finishNewStancesIntro();
    }
  }

  function beginFlightDomAnimations(viewIntro) {
    const intro = newStancesIntroRef.current;
    const layer = introFlightLayerRef.current;
    if (!layer || intro.flightDomActive) return;

    intro.waapiHandles = [];
    layer.replaceChildren();

    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = canonicalAvatarSrc(`${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`);

    intro.items.forEach((item, itemIndex) => {
      if (item.landed) return;
      const baseSide = item.stagingSidePx || Math.max(8, item.finalSide * viewIntro.scale);
      const shell = document.createElement("div");
      shell.className = `newStancesFlightAvatar newStancesFlightAvatar--${item.stance}`;
      shell.style.width = `${baseSide}px`;
      shell.style.height = `${baseSide}px`;
      shell.dataset.xUserId = item.xUserId;

      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      const url = resolveIntroAvatarUrl(item);
      const cached = getGraphAvatar(url);
      img.src =
        cached?.complete && cached.naturalWidth > 0 ? cached.src : url || missingSrc;
      shell.appendChild(img);
      layer.appendChild(shell);

      const handle = startWaapiFlightAnimation({
        element: shell,
        item,
        view: viewIntro,
        reducedMotion: intro.reducedMotion,
        itemIndex,
        onFinished: onFlightAvatarLanded,
      });
      if (handle) intro.waapiHandles.push(handle);
    });

    if (!intro.waapiHandles.length) {
      layer.replaceChildren();
      scheduleDraw();
      return;
    }

    intro.flightDomActive = true;
    scheduleDraw();

    requestAnimationFrame(() => {
      if (!intro.active || !intro.flightDomActive) return;
      const live = intro.waapiHandles.filter(
        (h) => h.animation.playState === "running" || h.animation.playState === "pending"
      );
      if (live.length > 0) return;
      intro.flightDomActive = false;
      cancelWaapiFlight(intro.waapiHandles);
      intro.waapiHandles = [];
      layer.replaceChildren();
      scheduleDraw();
    });

    if (intro.motionProfiler && intro.motionDebug) {
      setTimeout(() => {
        if (!intro.motionProfiler || !intro.motionDebug) return;
        if (intro.motionProfiler.shouldSimplifyEffects(INTRO_FLIGHT_PERF_SAMPLE_MS)) {
          intro.simplifiedEffects = true;
          for (const child of layer.children) {
            child.classList.add("newStancesFlightAvatar--simplified");
          }
        }
        const report = intro.motionProfiler.buildReport({
          flightDurationMs: flightDurationMs(intro.reducedMotion),
          flyingAvatarCount: intro.items.length,
          simplifiedEffects: intro.simplifiedEffects,
          reducedMotion: intro.reducedMotion,
        });
        const debugEl = introMotionDebugRef.current;
        if (debugEl) {
          debugEl.textContent = [
            `FPS (250ms): ${report.measuredFps}`,
            `Long frames >32ms: ${report.longFramesAbove32Ms}`,
            `Flight: ${report.flightDurationMs}ms`,
            `Avatars: ${report.flyingAvatarCount}`,
            `Simplified: ${report.simplifiedEffects ? "yes" : "no"}`,
            `Reduced motion: ${report.reducedMotion ? "yes" : "no"}`,
          ].join("\n");
        }
        if (typeof console !== "undefined" && console.info) {
          console.info("[newStances motion]", report);
        }
      }, INTRO_FLIGHT_PERF_SAMPLE_MS + 40);
    }
  }

  function finishNewStancesIntro() {
    const intro = newStancesIntroRef.current;
    if (!intro.active) return;
    cleanupFlightDom();
    releaseGraphSnapshot();
    if (intro.rafId) cancelAnimationFrame(intro.rafId);
    intro.rafId = 0;
    intro.active = false;
    // Panel exit fade has completed with the final landing; clear it so the
    // element is reset for the next intro (opacity already ~0, so no visible jump).
    intro.panelExiting = false;
    const panelEl = introPanelRef.current;
    if (panelEl) {
      panelEl.style.transition = "none";
      panelEl.style.opacity = "0";
      panelEl.style.display = "none";
    }
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
    setNewStancesUi((prev) => ({
      headingOpacity: 0,
      debug: false,
      debugMotion: false,
      bandActive: prev.bandActive,
      ariaLabels: [],
    }));
    introBandLiftReleasePendingRef.current = true;
    syncHeadingOpacity(0);
    scheduleDraw();
  }

  function newStancesIntroTick() {
    const intro = newStancesIntroRef.current;
    if (!intro.active) return;
    const now = performance.now();
    const elapsed = now - intro.startedAt;
    const prevPhase = intro.lastPhase || "fade-in";
    const phase = getIntroPhase(elapsed, intro.reducedMotion);
    intro.phase = phase;

    if (prevPhase !== phase) {
      intro.lastPhase = phase;
      if (phase === "flying" && !intro.flightDomActive) {
        intro.captureSnapshotPending = true;
        // Keep the glass panel visible and start its GPU-composited exit fade so
        // it only fully disappears once the last avatar has landed (title first).
        startPanelFlightExit(intro);
        syncHeadingOpacity(headingOpacityForPhase(phase, elapsed, intro.reducedMotion, intro.items.length));
        scheduleDraw();
      }
    }

    if (phase === "flying") {
      if (intro.motionProfiler) intro.motionProfiler.tick(now);
      for (const item of intro.items) {
        if (!item.landed && now >= item.flightEnd) {
          onFlightAvatarLanded(item.xUserId);
        }
      }
      if (!intro.flightDomActive) {
        scheduleDraw();
      }
      if (elapsed < INTRO_TIMING.holdMs + INTRO_TIMING.headingFadeOutMs) {
        syncHeadingOpacity(
          headingOpacityForPhase(phase, elapsed, intro.reducedMotion, intro.items.length)
        );
      } else if (intro.headingOpacityCached !== 0) {
        syncHeadingOpacity(0);
      }
      if (intro.items.every((it) => it.landed)) {
        finishNewStancesIntro();
        return;
      }
      intro.rafId = requestAnimationFrame(newStancesIntroTick);
      return;
    }

    if (phase === "done") {
      finishNewStancesIntro();
      return;
    }

    syncHeadingOpacity(headingOpacityForPhase(phase, elapsed, intro.reducedMotion, intro.items.length));
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
        return canonicalAvatarSrc(`${baseNoSlash}${rel}?v=${AVATAR_REV}`);
      }
      return nodeUrl ? canonicalAvatarSrc(nodeUrl) : missingSrc;
    });
    if (!items.length) return;

    for (const it of items) {
      it.avatarUrl = resolveIntroAvatarUrl(it);
    }

    const cache = avatarCacheRef.current;
    const hooked = avatarHookedRef.current;
    for (const it of items) {
      const url = it.avatarUrl;
      if (!url) continue;
      const key = canonicalAvatarSrc(url);
      const img = getAvatar(key);
      cache.set(key, img);
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
    const motionDebug = parseDebugNewStancesMotionParams(
      typeof window !== "undefined" ? window.location.search : ""
    );
    if (motionDebug.enabled && typeof console !== "undefined" && console.info) {
      console.info("[newStances motion] reduced-motion preference:", readReducedMotionPreference());
    }
    intro.active = true;
    intro.startedAt = performance.now();
    intro.lastPhase = "fade-in";
    intro.flightDomActive = false;
    intro.graphFrozen = false;
    intro.captureSnapshotPending = false;
    intro.simplifiedEffects = false;
    intro.motionDebug = motionDebug.enabled;
    intro.motionProfiler = motionDebug.enabled ? new IntroFlightMotionProfiler(intro.startedAt) : null;
    intro.waapiHandles = [];
    intro.headingOpacityCached = -1;
    intro.panelExiting = false;
    // Reset the panel element so per-frame fade-in works crisply and the CSS
    // entrance animation re-triggers on this fresh appearance.
    const panelElReset = introPanelRef.current;
    if (panelElReset) {
      panelElReset.style.transition = "none";
      panelElReset.style.opacity = "0";
      panelElReset.style.display = "none";
    }
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

    setNewStancesUi({
      headingOpacity: 0,
      debug: debug.enabled,
      debugMotion: motionDebug.enabled,
      bandActive: true,
      ariaLabels: scheduled.map((it) => introAvatarAriaLabel(it.handle, it.stance)),
    });
    if (intro.rafId) cancelAnimationFrame(intro.rafId);
    intro.rafId = requestAnimationFrame(newStancesIntroTick);
    scheduleDraw();
  }

  function drawNewStancesOverlay(cw, ch, dpr) {
    const introCanvas = introCanvasRef.current;
    const intro = newStancesIntroRef.current;
    if (!introCanvas) return;
    const ictx = introCanvas.getContext("2d");
    if (!ictx) return;

    if (introCanvas.width !== Math.floor(cw * dpr) || introCanvas.height !== Math.floor(ch * dpr)) {
      introCanvas.width = Math.floor(cw * dpr);
      introCanvas.height = Math.floor(ch * dpr);
      introCanvas.style.width = `${cw}px`;
      introCanvas.style.height = `${ch}px`;
      ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    ictx.clearRect(0, 0, cw, ch);

    if (!intro.active || !intro.items.length) {
      syncIntroOverlayDom({ x: 0, y: 0, w: 0, h: 0 }, 0, intro, 0, "idle");
      return;
    }

    const nowIntro = performance.now();
    const elapsedIntro = nowIntro - intro.startedAt;
    const phase = getIntroPhase(elapsedIntro, intro.reducedMotion);
    const viewIntro = getNewStancesStagingView();

    if (intro.flightDomActive) {
      syncIntroOverlayDom({ x: 0, y: 0, w: 0, h: 0 }, 0, intro, elapsedIntro, phase);
      return;
    }

    const stagingSide = intro.items[0]?.stagingSidePx || 48;
    const panelBounds = computeStagingPanelBounds(intro.items.length, stagingSide, viewIntro);
    const panelAlpha = stagingPanelOpacityForPhase(
      phase,
      elapsedIntro,
      intro.items.length,
      intro.reducedMotion
    );
    if (phase === "flying") {
      syncIntroOverlayDom({ x: 0, y: 0, w: 0, h: 0 }, 0, intro, elapsedIntro, phase);
    } else {
      syncIntroOverlayDom(panelBounds, panelAlpha, intro, elapsedIntro, phase);
    }

    const simpleFlightStroke = phase === "flying" && (intro.simplifiedEffects || isFirefoxBrowser);

    let itemIndex = 0;
    for (const item of intro.items) {
      if (item.landed) continue;
      const pos = computeFlightScreenPos(item, nowIntro, viewIntro, intro.reducedMotion);
      const inFlight = nowIntro >= item.flightStart;
      const entrance =
        inFlight || phase === "hold"
          ? { opacity: 1, scale: 1 }
          : introAvatarEntrance(itemIndex, elapsedIntro, intro.reducedMotion);
      const sidePx = Math.max(8, pos.sidePx * entrance.scale);
      const drawX = pos.sx - sidePx / 2;
      const drawY = pos.sy - sidePx / 2;
      const rOv = Math.min(14, sidePx * 0.22);
      const aura = introStanceAura(item.stance);
      ictx.save();
      ictx.globalAlpha = entrance.opacity;
      const img = getGraphAvatar(resolveIntroAvatarUrl(item));
      if (img?.complete && img.naturalWidth > 0) {
        ictx.save();
        ictx.beginPath();
        if (typeof ictx.roundRect === "function") {
          ictx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
        } else {
          ictx.rect(drawX, drawY, sidePx, sidePx);
        }
        ictx.clip();
        ictx.drawImage(img, drawX, drawY, sidePx, sidePx);
        ictx.restore();
      } else {
        ictx.fillStyle = aura.fill;
        ictx.beginPath();
        if (typeof ictx.roundRect === "function") {
          ictx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
        } else {
          ictx.rect(drawX, drawY, sidePx, sidePx);
        }
        ictx.fill();
      }
      ictx.strokeStyle = aura.border;
      ictx.lineWidth = 2;
      if (!simpleFlightStroke) {
        ictx.shadowColor = aura.glow;
        ictx.shadowBlur = item.stance === "neutral" ? 9 : 10;
      }
      ictx.beginPath();
      if (typeof ictx.roundRect === "function") {
        ictx.roundRect(drawX, drawY, sidePx, sidePx, rOv);
      } else {
        ictx.rect(drawX, drawY, sidePx, sidePx);
      }
      ictx.stroke();
      ictx.shadowBlur = 0;
      ictx.restore();
      itemIndex += 1;
    }
  }

  // One-time: begin the panel's flight-exit fade. A single CSS opacity
  // transition (duration = full flight span) owns the disappearance from here,
  // so there are no extra per-frame renders while avatars fly.
  function startPanelFlightExit(intro) {
    const panelEl = introPanelRef.current;
    if (!panelEl) return;
    intro.panelExiting = true;
    const durMs = panelFlightExitDurationMs(intro.items.length, intro.reducedMotion);
    panelEl.style.transition = `opacity ${durMs}ms cubic-bezier(0.55, 0, 1, 0.45)`;
    panelEl.style.opacity = "0";
  }

  function syncIntroOverlayDom(panelBounds, panelAlpha, intro, elapsedIntro, phase) {
    const panelEl = introPanelRef.current;
    const countdownEl = introCountdownRef.current;
    const panelOpacity = Math.min(1, panelAlpha / 0.94);
    if (panelEl && !intro.panelExiting) {
      if (panelAlpha > 0.01) {
        panelEl.style.display = "block";
        panelEl.style.left = `${panelBounds.x}px`;
        panelEl.style.top = `${panelBounds.y}px`;
        panelEl.style.width = `${panelBounds.w}px`;
        panelEl.style.height = `${panelBounds.h}px`;
        panelEl.style.opacity = String(panelOpacity);
      } else {
        panelEl.style.display = "none";
      }
    }
    if (countdownEl) {
      let showCountdown = false;
      for (let d = 0; d < 3; d++) {
        const op = introCountdownDotOpacity(d, phase, elapsedIntro, intro.reducedMotion);
        const dot = countdownEl.children[d];
        if (dot) dot.style.opacity = String(op);
        if (op > 0.13) showCountdown = true;
      }
      if (showCountdown && panelAlpha > 0.01) {
        countdownEl.style.display = "flex";
        countdownEl.style.left = `${panelBounds.x + panelBounds.w / 2}px`;
        countdownEl.style.top = `${panelBounds.y + panelBounds.h - 14}px`;
        countdownEl.style.transform = "translateX(-50%)";
      } else {
        countdownEl.style.display = "none";
      }
    }
  }

  function drawIntroLandedNodesOnly(ctx) {
    const intro = newStancesIntroRef.current;
    if (!intro.landedIds.size) return;
    const nodes = nodesRef.current;
    const view = viewRef.current;
    if (!nodes?.length || !view) return;
    const { scale, tx, ty } = view;
    const labels = labelsRef.current;
    const radius = (side) => Math.min(14, side * 0.22);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    for (const n of nodes) {
      const xid = String(n.x_user_id ?? "").trim();
      if (!xid || !intro.landedIds.has(xid)) continue;
      const drawHalf = n.side / 2;
      const drawX = n.x - drawHalf;
      const drawY = n.y - drawHalf;
      const drawSide = n.side;
      const r = radius(drawSide);
      const stance = getNodeStance(n, labels);
      const aura = stanceColor(stance);
      const baseFill =
        aura && n.tweetCount > 0
          ? aura.replace(/[\d.]+\)$/, "0.16)")
          : n.tweetCount > 0
            ? "rgba(40,45,55,0.16)"
            : "rgba(70,75,85,0.16)";
      const baseStroke = aura ? aura.replace(/[\d.]+\)$/, "0.72)") : "rgba(120,130,150,0.72)";
      const img = getGraphAvatar(resolveDrawAvatarUrl(n));
      if (img?.complete && img.naturalWidth > 0) {
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
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(drawX, drawY, drawSide, drawSide, r);
      } else {
        ctx.rect(drawX, drawY, drawSide, drawSide);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    drawRef.current = draw;
    const dragFrameStart = cameraInteractingRef.current ? performance.now() : 0;
    if (isPerfDebugEnabled()) perfInc("drawCalls");

    // Suppress intermediate paints while the layout is settling off the main
    // thread. This prevents avatar `load` events and simulation ticks from
    // showing nodes mid-flight; we paint exactly once when settling completes.
    // Avatar loads still schedule draws that no-op here, then paint progressively
    // after settle without waiting for the full image set.
    if (layoutSettlingRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rawDpr = window.devicePixelRatio || 1;
    const dpr = isFirefoxBrowser ? Math.min(rawDpr, 1.5) : rawDpr;
    const cw = Math.max(1, w);
    const ch = Math.max(1, h);

    if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
      canvas.width = Math.floor(cw * dpr);
      canvas.height = Math.floor(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      invalidatePanLayer();
    }

    const introEarly = newStancesIntroRef.current;
    const snap = introGraphSnapshotRef.current;
    const useFrozenIntroGraph =
      introEarly.active && introEarly.graphFrozen && snap.active && snap.canvas;

    if (useFrozenIntroGraph) {
      ctx.drawImage(snap.canvas, 0, 0, cw, ch);
      drawIntroLandedNodesOnly(ctx);
      drawNewStancesOverlay(cw, ch, dpr);
      return;
    }

    // Fast pan/pinch path: blit a screen-space content snapshot with the pan
    // delta and redraw only the fixed starfield. No node/halo recompute.
    const panLayer = panLayerRef.current;
    const camUser = camRef.current;
    if (
      cameraInteractingRef.current &&
      panLayer.valid &&
      !suppressStarfieldRef.current &&
      panLayer.dpr === dpr &&
      panLayer.cw === cw &&
      panLayer.ch === ch &&
      panLayer.scaleMul === camUser.scaleMul
    ) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const starfieldFast = getStarfieldCanvas(cw, ch, dpr);
      if (starfieldFast) ctx.drawImage(starfieldFast, 0, 0, cw, ch);
      const dx = camUser.panX - panLayer.panX;
      const dy = camUser.panY - panLayer.panY;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(panLayer.canvas, dx * dpr, dy * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Keep viewRef in sync for hit-testing after drag ends.
      const fit = fitRef.current;
      viewRef.current = {
        scale: fit.scale * camUser.scaleMul,
        tx: fit.tx + camUser.panX,
        ty: fit.ty + camUser.panY,
      };
      if (isPerfDebugEnabled()) {
        perfInc("fastPanDrawCalls");
        if (dragFrameStart) perfRecordDragFrame(performance.now() - dragFrameStart);
      }
      return;
    }

    ctx.clearRect(0, 0, cw, ch);

    // Cached starfield (screen space) — skipped when capturing the pan layer.
    if (!suppressStarfieldRef.current) {
      const starfield = getStarfieldCanvas(cw, ch, dpr);
      if (starfield) ctx.drawImage(starfield, 0, 0, cw, ch);
      if (isPerfDebugEnabled()) {
        perfSetMs("firstBackgroundPaintMs", perfNowSinceNav());
      }
    }
    if (isPerfDebugEnabled()) perfInc("fullDrawCalls");

    const nodes = nodesRef.current;
    const qset = filteredHandlesSet;
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

    const selectionFxActive = selectionFxRef.current.handle != null;
    // Freeze fit during selection FX and during camera drag so O(n) bounds work
    // and neighbor nudges do not rescale the whole graph mid-interaction.
    const reuseFit =
      (selectionFxActive || cameraInteractingRef.current || suppressStarfieldRef.current) &&
      frozenFitRef.current;

    let fitScale;
    let fitTx;
    let fitTy;
    if (reuseFit) {
      ({ scale: fitScale, tx: fitTx, ty: fitTy } = frozenFitRef.current);
    } else {
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
      fitScale = Math.min((cw - pad * 2) / blobW, (ch - pad * 2) / blobH) * 0.96;
      const blobCx = (minX + maxX) / 2;
      const blobCy = (minY + maxY) / 2;
      fitTx = cw / 2 - blobCx * fitScale;
      fitTy = ch / 2 - blobCy * fitScale;
      frozenFitRef.current = { scale: fitScale, tx: fitTx, ty: fitTy };
    }

    fitRef.current = { scale: fitScale, tx: fitTx, ty: fitTy };

    const user = camRef.current;
    const scale = fitScale * user.scaleMul;
    const tx = fitTx + user.panX;
    const ty = fitTy + user.panY;

    viewRef.current = { scale, tx, ty };

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    // Ambient cluster halos — world-space pass before avatars.
    if (showClusterHalo) {
      const resolveClusterStance = (n) => getNodeStance(n, labels);
      if (clusterHaloResumeSnapRef.current) {
        clusterHaloSmoothRef.current = snapClusterHaloState(nodes, resolveClusterStance);
        clusterHaloResumeSnapRef.current = false;
      }
      const breathEpoch = clusterHaloBreathEpochRef.current;
      const haloNowMs = breathEpoch != null ? breathEpoch : performance.now();
      if (breathEpoch != null) clusterHaloBreathEpochRef.current = null;
      clusterHaloSmoothRef.current = drawClusterHalos(
        ctx,
        nodes,
        resolveClusterStance,
        haloNowMs,
        clusterHaloCacheRef.current,
        clusterHaloSmoothRef.current
      );
    }

    ctx.restore();

    // Legacy stance anchor zones (production default when cluster halos are off).
    if (!showClusterHalo) {
      const r = regionRef.current;
      const againstCx = r?.stanceCenterX?.[STANCE.AGAINST] ?? (w * 0.33);
      const neutralCx = r?.stanceCenterX?.[STANCE.NEUTRAL] ?? (w * 0.5);
      const approveCx = r?.stanceCenterX?.[STANCE.APPROVE] ?? (w * 0.67);
      const zoneCyWorld = h / 2;
      const againstX = againstCx * scale + tx;
      const neutralX = neutralCx * scale + tx;
      const approveX = approveCx * scale + tx;
      const zoneY = zoneCyWorld * scale + ty;
      const baseRadius = Math.min(cw, ch) * (isFirefoxBrowser ? 0.28 : 0.31);
      const zoneRadius = Math.max(120, Math.min(420, baseRadius));
      const getZone = (key, rgb, alpha) => {
        const cacheKey = `${key}|${Math.round(zoneRadius)}|${alpha}|${glowProfile.id}`;
        const cache = stanceZoneCacheRef.current;
        if (cache.has(cacheKey)) return cache.get(cacheKey);
        const sprite = createStanceZoneSprite(rgb, zoneRadius, alpha);
        if (cache.size > 24) cache.clear();
        cache.set(cacheKey, sprite);
        return sprite;
      };
      const zoneAlphaMul = glowProfile.zoneAlphaMultiplier;
      const redZone = getZone("red", [220, 38, 38], (isFirefoxBrowser ? 0.055 : 0.07) * zoneAlphaMul);
      const neutralZone = getZone("neutral", [156, 163, 175], (isFirefoxBrowser ? 0.032 : 0.042) * zoneAlphaMul);
      const greenZone = getZone("green", [34, 197, 94], (isFirefoxBrowser ? 0.055 : 0.07) * zoneAlphaMul);
      const drawZone = (sprite, cx, cy) => {
        const rad = sprite.width / 2;
        ctx.drawImage(sprite, cx - rad, cy - rad);
      };
      drawZone(redZone, againstX, zoneY);
      drawZone(neutralZone, neutralX, zoneY);
      drawZone(greenZone, approveX, zoneY);
    }

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const radius = (side) => Math.min(14, side * 0.22);
    const glowQuality = glowProfile.quality;
    const nonEmphasizedGlowPasses = glowProfile.nonEmphasizedPasses;
    const getGlow = (aura, drawSide, emphasize) => {
      const bucketSide = Math.max(6, Math.round(drawSide));
      const key = `${aura}|${bucketSide}|${emphasize ? "1" : "0"}|${glowProfile.id}`;
      const cacheKey = `${GLOW_CACHE_VERSION}|${key}`;
      const cache = glowCacheRef.current;
      if (cache.has(cacheKey)) return cache.get(cacheKey);
      const sprite = createGlowSprite(aura, bucketSide, emphasize, glowQuality, {
        blurMultiplier: glowProfile.blurMultiplier,
        opacityMultiplier: glowProfile.opacityMultiplier,
      });
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
        const hasBreathingHalo =
          useBreathingHalo &&
          breathingHaloHandlesRef.current.has(normalizeHandle(n.handle));
        if (!hasBreathingHalo) {
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
      }

      const img = getGraphAvatar(resolveDrawAvatarUrl(n));
      if (img && img.complete && img.naturalWidth > 0) {
        if (isPerfDebugEnabled()) {
          perfSetMs("firstAvatarPaintMs", perfNowSinceNav());
        }
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

    if (useBreathingHalo && breathingHaloHandlesRef.current.size > 0) {
      const breathingReducedMotion = readReducedMotionPreference();
      const breathNowMs = performance.now();
      for (const n of nodes) {
        const handleKey = normalizeHandle(n.handle);
        if (!breathingHaloHandlesRef.current.has(handleKey)) continue;
        if (!playbackShowsWorldNode(n)) continue;
        if (!introShowsWorldNode(n)) continue;
        const stance = getNodeStance(n, labels);
        const aura = stanceColor(stance);
        if (!aura) continue;
        const glow = getGlow(aura, n.side, false);
        if (!glow?.canvas) continue;
        const breathAlpha = breathingHaloAlpha(
          breathNowMs,
          breathingHaloPhaseOffsetMs(n.handle),
          breathingReducedMotion
        );
        const drawHalf = n.side / 2;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = breathAlpha;
        ctx.drawImage(glow.canvas, n.x - drawHalf - glow.pad, n.y - drawHalf - glow.pad);
        for (let p = 1; p < nonEmphasizedGlowPasses; p++) {
          ctx.drawImage(glow.canvas, n.x - drawHalf - glow.pad, n.y - drawHalf - glow.pad);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.restore();
      }
    }

    const base = [], hovered = [], selected = [];
    const hoverScale = 1.14;
    const selectedScaleBase = isFirefoxBrowser ? 1.72 : 2;
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
    const selFx = selectionFxRef.current;
    const adminSelFxOn = selFx.handle != null;
    for (const n of nodes) {
      if (!playbackShowsWorldNode(n)) continue;
      if (!introShowsWorldNode(n)) continue;
      if (curSelected && n.handle === curSelected) {
        // Selected node always draws (it may be enlarged well past the cull box).
        selected.push(n);
      } else if (curHover && n.handle === curHover.handle) {
        if (isVisible(n, hoverScale)) hovered.push(n);
      } else if (isVisible(n, 1)) {
        base.push(n);
      }
    }
    for (const n of base) drawNode(n, 1, false);
    for (const n of hovered) drawNode(n, hoverScale, true);
    for (const n of selected) {
      const useFx = adminSelFxOn && normalizeHandle(n.handle) === normalizeHandle(selFx.handle);
      drawNode(n, useFx ? selFx.scale : selectedScale, true);
    }

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
        const img = getGraphAvatar(resolveDrawAvatarUrl(nin));
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

    drawNewStancesOverlay(cw, ch, dpr);

    if (intro.captureSnapshotPending) {
      captureGraphSnapshot(cw, ch, dpr);
      intro.captureSnapshotPending = false;
      beginFlightDomAnimations(getNewStancesStagingView());
    }

    if (introBandLiftReleasePendingRef.current) {
      introBandLiftReleasePendingRef.current = false;
      requestAnimationFrame(() => {
        setNewStancesUi((prev) => (prev.bandActive ? { ...prev, bandActive: false } : prev));
      });
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
    refreshCanvasRect();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer capture optional for mouse events */
    }
  }

  function onMouseUp() {
    isPanningRef.current = false;
    endCameraInteraction();
  }

  function onWheel(e) {
    e.preventDefault();
    // Zoom invalidates the pan-layer blit (scaleMul changes).
    invalidatePanLayer();
    const rect = canvasRectRef.current || e.currentTarget.getBoundingClientRect();
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
    scheduleDraw();
  }

  function onMouseMove(e) {
    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      if (!cameraInteractingRef.current && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        beginCameraInteraction();
      }
      camRef.current = {
        ...camRef.current,
        panX: panStartRef.current.panX + dx,
        panY: panStartRef.current.panY + dy,
      };
      // One draw per animation frame; no React state; no hover hit-test while dragging.
      scheduleDraw();
      return;
    }
    const rect = canvasRectRef.current || e.currentTarget.getBoundingClientRect();
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

  // Shared selection used by both desktop click and mobile tap so behavior
  // (popup open/close + manual-edit) stays identical across input types.
  function selectAtCanvasPoint(mx, my) {
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

  selectAtPointRef.current = selectAtCanvasPoint;

  function onClick(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    selectAtCanvasPoint(mx, my);
  }

  // Native touch listeners (attached non-passive so preventDefault stops page
  // scroll/pinch-zoom). One finger pans, two fingers pinch-zoom about the
  // midpoint — both feed the existing camRef transform. Desktop mouse/wheel
  // handlers are untouched.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const st = touchStateRef.current;
    const ZOOM_MIN = 0.35;
    const ZOOM_MAX = 6;
    const TAP_MOVE_TOLERANCE_PX = 8;

    function beginGesture(touches) {
      const rect = canvasRectRef.current || canvas.getBoundingClientRect();
      canvasRectRef.current = rect;
      if (touches.length >= 2) {
        const t0 = touches[0];
        const t1 = touches[1];
        const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
        const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1;
        const v = viewRef.current || { scale: 1, tx: 0, ty: 0 };
        st.mode = "pinch";
        st.startDist = dist;
        st.startScaleMul = camRef.current.scaleMul;
        st.midWorldX = (midX - v.tx) / v.scale;
        st.midWorldY = (midY - v.ty) / v.scale;
        // Pinch changes scaleMul — use full draws, not the pan-layer blit.
        cameraInteractApiRef.current.invalidatePanLayer();
      } else if (touches.length === 1) {
        const t = touches[0];
        st.mode = "pan";
        st.startX = t.clientX;
        st.startY = t.clientY;
        st.startPanX = camRef.current.panX;
        st.startPanY = camRef.current.panY;
      } else {
        st.mode = "none";
      }
    }

    function onTouchStart(e) {
      e.preventDefault();
      st.moved = false;
      beginGesture(e.touches);
      if (e.touches.length >= 2) {
        // Pinch uses full redraws (scale changes); mark interacting to pause halo RAF.
        cameraInteractingRef.current = true;
        cameraInteractApiRef.current.invalidatePanLayer();
      }
    }

    function onTouchMove(e) {
      e.preventDefault();
      if (st.mode === "pinch" && e.touches.length >= 2) {
        const rect = canvasRectRef.current || canvas.getBoundingClientRect();
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
        const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY) || 1;
        const fit = fitRef.current;
        const nextScaleMul = clamp(st.startScaleMul * (dist / st.startDist), ZOOM_MIN, ZOOM_MAX);
        const newScale = fit.scale * nextScaleMul;
        // Keep the world point under the initial midpoint locked to the current
        // midpoint → smooth pinch-zoom + two-finger pan in one gesture.
        camRef.current = {
          ...camRef.current,
          scaleMul: nextScaleMul,
          panX: midX - fit.tx - st.midWorldX * newScale,
          panY: midY - fit.ty - st.midWorldY * newScale,
        };
        st.moved = true;
        cameraInteractApiRef.current.invalidatePanLayer();
        cameraInteractApiRef.current.scheduleDraw();
      } else if (st.mode === "pan" && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - st.startX;
        const dy = t.clientY - st.startY;
        if (Math.abs(dx) > TAP_MOVE_TOLERANCE_PX || Math.abs(dy) > TAP_MOVE_TOLERANCE_PX) {
          st.moved = true;
          if (!cameraInteractingRef.current) {
            cameraInteractApiRef.current.begin();
          }
        }
        // Panning preserves the current zoom level (scaleMul untouched).
        camRef.current = {
          ...camRef.current,
          panX: st.startPanX + dx,
          panY: st.startPanY + dy,
        };
        hoverRef.current = null;
        hoverDrawHandleRef.current = null;
        cameraInteractApiRef.current.scheduleDraw();
      }
    }

    function onTouchEnd(e) {
      if (st.mode === "pan" && !st.moved && e.touches.length === 0) {
        const t = e.changedTouches[0];
        if (t) {
          const rect = canvasRectRef.current || canvas.getBoundingClientRect();
          const mx = t.clientX - rect.left;
          const my = t.clientY - rect.top;
          if (selectAtPointRef.current) selectAtPointRef.current(mx, my);
        }
      }
      if (e.touches.length > 0) {
        // Fingers remain (e.g. lifting one of two) — re-init with what's left and
        // suppress a stray tap.
        beginGesture(e.touches);
        st.moved = true;
      } else {
        st.mode = "none";
        cameraInteractApiRef.current.end();
      }
    }

    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd, { passive: false });
    canvas.addEventListener("touchcancel", onTouchEnd, { passive: false });
    return () => {
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [stanceListsViewEnabled, loading, err]);

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
                <label style={styles.optionsItem}>
                  <input
                    type="checkbox"
                    checked={joinDateFilterEnabled}
                    onChange={(e) => enableJoinDateFilter(e.target.checked)}
                  />
                  <span>X join date</span>
                  <span style={styles.optionsState}>{joinDateFilterEnabled ? "ON" : "OFF"}</span>
                </label>
                {joinDateFilterEnabled && joinDateMinYear != null && joinDateMaxYear != null ? (
                  <XJoinDateRangeSlider
                    boundMin={joinDateBoundMin}
                    boundMax={joinDateBoundMax}
                    minYear={joinDateMinYear}
                    maxYear={joinDateMaxYear}
                    onChange={onJoinDateRangeChange}
                    showingCount={joinDateFilterStats.showingCount}
                    totalCount={joinDateFilterStats.totalCount}
                  />
                ) : null}
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
              {meHasStance && meStanceToolbar ? (
                <div
                  style={{ ...styles.stanceSegment, gridTemplateColumns: "1fr" }}
                  role="group"
                  aria-label="Your stance"
                >
                  <button
                    type="button"
                    className={`stanceSeg stanceSeg--solo ${meStanceToolbar.className} is-active ${stancePop === meStance ? "just-selected" : ""}`}
                    onClick={() => setStanceChoiceOpen(true)}
                    disabled={authBusy}
                    aria-haspopup="dialog"
                    aria-expanded={stanceChoiceOpen}
                    title={`Your stance: ${meStanceToolbar.label}. Click to change.`}
                  >
                    {meStanceToolbar.label}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="toolbarBtn toolbarBtn--primary"
                  onClick={() => setStanceChoiceOpen(true)}
                  disabled={authBusy}
                  aria-haspopup="dialog"
                  aria-expanded={stanceChoiceOpen}
                  title="Choose your stance"
                >
                  Choose stance
                </button>
              )}
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

      <div style={styles.main}>
        <div ref={(el) => { containerRef.current = el; canvasWrapPulseRef.current = el; }} style={styles.canvasWrap}>
          {!stanceListsViewEnabled ? (
            <>
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
              {joinDateFilterActive && visibleAccounts.length === 0 ? (
                <div className="joinDateEmptyMsg" role="status">
                  No accounts joined X in this range.
                </div>
              ) : null}
              <div ref={introPanelRef} className="newStancesPanel" aria-hidden="true" />
              <canvas ref={introCanvasRef} style={styles.introCanvas} aria-hidden="true" />
              <div ref={introFlightLayerRef} className="newStancesFlightLayer" aria-hidden="true" />
              {(newStancesUi.headingOpacity > 0.01 || newStancesUi.bandActive) && (
                <div
                  ref={introHeadingRef}
                  className="newStancesHeading"
                  style={{ opacity: newStancesUi.headingOpacity }}
                  aria-live="polite"
                >
                  {NEW_STANCES_HEADING}
                </div>
              )}
              {newStancesUi.bandActive && newStancesUi.ariaLabels.length > 0 && (
                <div className="sr-only" aria-live="polite">
                  {newStancesUi.ariaLabels.join("; ")}
                </div>
              )}
              <div ref={introCountdownRef} className="newStancesCountdown" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              {newStancesUi.debug && (
                <div className="newStancesDebugLabel">Debug new stances</div>
              )}
              {newStancesUi.debugMotion && (
                <div ref={introMotionDebugRef} className="newStancesMotionDebug" aria-hidden="true" />
              )}
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
        <div style={styles.footerNoteLine}>
          <span>Stances are self-reported or curated.</span>
          <CuratedStanceInfo />
        </div>
        {stanceListsViewEnabled ? (
          <div>Within each stance: avatar + @username, multi-column grid, followers (highest first).</div>
        ) : equalAvatarSizeEnabled ? (
          <div>
            Equal-size avatars packed to fill the screen; within each stance, highest followers fill
            left-to-right, then down.
          </div>
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
      <StanceChoiceCard
        open={Boolean(me?.authenticated) && stanceChoiceOpen}
        mode={stanceChoiceMode(me)}
        currentStance={meStance}
        busy={authBusy}
        onSelect={chooseStanceFromCard}
        onDismiss={() => setStanceChoiceOpen(false)}
      />
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
    padding: "12px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    background: "rgba(15,23,42,0.85)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    minHeight: 60,
    boxSizing: "border-box",
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
    width: 22,
    height: 22,
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
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 30,
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "nowrap",
    justifyContent: "flex-end",
    maxWidth: "calc(100vw - 32px)",
  },
  // One cohesive floating toolbar surface that groups all account controls.
  // Height/radius match the left search field so both header chips feel congruent.
  accountBar: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 36,
    boxSizing: "border-box",
    padding: "2px 8px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(17,24,39,0.72)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
    flexWrap: "nowrap",
    justifyContent: "flex-end",
    maxWidth: "calc(100vw - 32px)",
  },
  // Subtle vertical separator between toolbar groups.
  barDivider: {
    width: 1,
    alignSelf: "center",
    height: 18,
    minHeight: 18,
    margin: "0 2px",
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
    gap: 2,
    padding: 2,
    borderRadius: 8,
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
    height: 36,
    boxSizing: "border-box",
    padding: "0 12px",
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
    maxWidth: "min(320px, calc(100vw - 16px))",
    padding: 8,
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(15,23,42,0.98)",
    boxShadow: "0 8px 22px rgba(0,0,0,0.35)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    zIndex: 120,
    boxSizing: "border-box",
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
    isolation: "isolate",
  },
  canvas: {
    width: "100%",
    height: "100%",
    display: "block",
    cursor: "pointer",
    position: "relative",
    zIndex: 2,
  },
  introCanvas: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    display: "block",
    pointerEvents: "none",
    zIndex: 15,
  },
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
    zIndex: 25,
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
  footerNoteLine: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
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
