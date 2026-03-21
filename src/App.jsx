import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { forceCollide, forceManyBody, forceCenter, forceSimulation, forceX, forceY } from "d3-force";
import { getAvatar } from "./utils/avatarCache";
import { fetchCommunityUsers } from "./api/community";
import { BitcoinQr } from "./components/BitcoinQr";
import { StatisticsModal } from "./components/StatisticsModal";
import { applyManualStanceUpdate, isPrivilegedManualEditor } from "./utils/manualEditState";

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
  const path = String(a?.avatar_path ?? "").trim();
  if (path) return `${baseNoSlash}${path}?v=${AVATAR_REV}`;
  const remote = firstNonEmptyAvatarField(a);
  if (remote) return maybeProxyAvatarUrl(remote);
  return missingSrc;
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

/** Compute stance weights (sum of sqrt(followers)) and region layout. Neutral at width/2; all three in a tight band so islands stay cohesive. */
function computeStanceRegions(nodes, labels, width) {
  if (!nodes || nodes.length === 0) return null;
  let redW = 0, greyW = 0, greenW = 0;
  for (const d of nodes) {
    const stance = getNodeStance(d, labels);
    const w = Math.sqrt(Math.max(1, d.followers));
    if (stance === STANCE.AGAINST) redW += w;
    else if (stance === STANCE.NEUTRAL) greyW += w;
    else if (stance === STANCE.APPROVE) greenW += w;
    else greyW += w; // unlabeled -> neutral
  }
  const total = redW + greyW + greenW || 1;
  const gapPx = Math.max(12, width * 0.012);
  // Tight centered band keeps islands cohesive while preserving symmetric centers.
  const contentWidth = width * 0.6;
  const contentLeft = (width - contentWidth) / 2;
  const contentRight = contentLeft + contentWidth;
  const mid = width / 2;

  // Mild weighting for side widths while avoiding extreme visual drift.
  const baseRegion = contentWidth * 0.22;
  const scale = contentWidth * 0.16;
  const safeTotal = Math.max(total, 1);
  const redWidth = clamp(baseRegion + scale * (redW / safeTotal), contentWidth * 0.16, contentWidth * 0.34);
  const greenWidth = clamp(baseRegion + scale * (greenW / safeTotal), contentWidth * 0.16, contentWidth * 0.34);
  const greyWidth = clamp(baseRegion + scale * (greyW / safeTotal), contentWidth * 0.18, contentWidth * 0.36);

  // Neutral remains fixed center. Left/right centers are symmetric around neutral.
  const minCenterDist = Math.max(
    greyWidth / 2 + gapPx + redWidth / 2,
    greyWidth / 2 + gapPx + greenWidth / 2
  );
  const maxCenterDist = Math.min(
    mid - contentLeft - redWidth / 2,
    contentRight - mid - greenWidth / 2
  );
  const centerDist = clamp(contentWidth * 0.24, minCenterDist, maxCenterDist);
  const redCx = mid - centerDist;
  const greyCx = mid;
  const greenCx = mid + centerDist;

  const redEnd = redCx + redWidth / 2;
  const greyStart = greyCx - greyWidth / 2;
  const greyEnd = greyCx + greyWidth / 2;
  const greenStart = greenCx - greenWidth / 2;
  return {
    stanceCenterX: {
      [STANCE.AGAINST]: redCx,
      [STANCE.NEUTRAL]: greyCx,
      [STANCE.APPROVE]: greenCx,
    },
    redEnd,
    greyStart,
    greyEnd,
    greenStart,
    gapPx,
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
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [statsData, setStatsData] = useState(null);
  const [showDonateModal, setShowDonateModal] = useState(false);
  const [adminOptionsOpen, setAdminOptionsOpen] = useState(false);
  const [plebsMode, setPlebsMode] = useState(false);
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
  const stancePlaybackItemsRef = useRef(null);
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

  useEffect(() => {
    // Cleanup legacy persisted stance overrides so backend data is canonical across devices.
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

  function beginLogin() {
    window.location.assign("/auth/x/login");
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
      }
      await loadMe();
    } finally {
      setAuthBusy(false);
    }
  }

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
    if (!showStatsModal) return;
    let dead = false;
    (async () => {
      try {
        setStatsLoading(true);
        setStatsError("");
        const res = await fetch(`${API_BASE}/api/stats`, { credentials: "include" });
        if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
        const data = await res.json();
        if (!dead) setStatsData(data);
      } catch (e) {
        if (!dead) setStatsError(String(e?.message || e));
      } finally {
        if (!dead) setStatsLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [showStatsModal]);

  useEffect(() => {
    loadMe();
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
    if (!plebsMode) return accounts;
    return accounts.filter((a) => {
      const info = getFollowersFromUser(a);
      return info.source !== "none" && info.followers < 3000;
    });
  }, [accounts, plebsMode]);
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
    if (account?.avatar_path) return `${baseNoSlash}${account.avatar_path}?v=${AVATAR_REV}`;
    if (account?.avatar_url) return account.avatar_url;
    return `${baseNoSlash}/avatars/zndtoshi.jpg?v=${AVATAR_REV}`;
  }, [accounts]);
  const selectedHeaderAvatarSrc = useMemo(() => {
    if (!selectedHandle) return "";
    const key = normalizeHandle(selectedHandle);
    const account = accountByHandle.get(key) || null;
    const baseNoSlash = getBase().replace(/\/$/, "");
    const missingSrc = `${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`;
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
      usersChangedStanceAtLeastOnce: plebsMode ? 0 : num(statsData?.changed_ever),
      totalStanceChangesLast7Days: plebsMode ? 0 : num(statsData?.changes_last_7d),
      totalStanceChanges: plebsMode ? 0 : num(statsData?.total_changes),
      transitionCounts: !plebsMode && Array.isArray(statsData?.transition_counts)
        ? statsData.transition_counts
            .map((f) => ({
              from: flowNorm(f.from),
              to: flowNorm(f.to),
              count: num(f.count),
            }))
            .filter((f) => (f.from === null || f.from) && (f.to === "against" || f.to === "neutral" || f.to === "approve"))
        : [],
      recentChanges: !plebsMode && Array.isArray(statsData?.recent_changes)
        ? statsData.recent_changes
            .map((r) => ({
              x_user_id: String(r.x_user_id ?? ""),
              handle: String(r.handle ?? "").trim() || "(unknown)",
              from: flowNorm(r.from),
              to: flowNorm(r.to) || "neutral",
              changed_at: String(r.changed_at || ""),
              changed_by: String(r.changed_by || "").trim() || null,
            }))
            .filter((r) => r.to === "against" || r.to === "neutral" || r.to === "approve")
        : [],
      topFlowsLast7Days: !plebsMode && Array.isArray(statsData?.flows_last_7d)
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
  }, [statsData, visibleAccounts, labels, plebsMode]);

  async function refreshStatsNow() {
    try {
      const res = await fetch(`${API_BASE}/api/stats`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      setStatsData(data);
    } catch {
      // ignore on-demand stats refresh failures
    }
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

  // Load canonical accounts and mentions CSV from public/data
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const base = getBase();
        const [cleanedAccounts, mentionsRes] = await Promise.all([
          loadAccounts(),
          fetch(`${base}/data/mentions_bip110.csv?v=${DATA_REV}`).then((r) => (r.ok ? r.text() : "")),
        ]);
        if (dead) return;

        const accountsFiltered = cleanedAccounts.filter((r) => (r.handle ?? "").toString().trim().length > 0);

        let m = [];
        if (mentionsRes) {
          const parsed = await new Promise((resolve, reject) => {
            Papa.parse(mentionsRes, {
              header: true,
              skipEmptyLines: true,
              complete: (res) => resolve(res.data || []),
              error: (err) => reject(err),
            });
          });
          m = parsed;
        }
        const cleanedMentions = m
          .map((r) => ({
            handle: (r.handle ?? "").trim().toLowerCase(),
            tweet_id: (r.tweet_id ?? "").trim(),
            created_at: (r.created_at ?? "").trim(),
            tweet_url: (r.tweet_url ?? "").trim(),
            text_snippet: (r.text_snippet ?? "").trim(),
          }))
          .filter((r) => r.handle.length > 0 && (r.tweet_url.length > 0 || r.tweet_id.length > 0));

        setAccounts(accountsFiltered);
        setMentions(cleanedMentions);
      } catch (e) {
        setErr(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

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

  // Preload avatars once accounts are available.
  useEffect(() => {
    if (!visibleAccounts.length) return;
    const base = getBase();
    const baseNoSlash = base.replace(/\/$/, "");
    const missingSrc = `${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`;
    getAvatar(missingSrc);
    for (const a of visibleAccounts) {
      const src = resolveAvatarUrlForAccount(a, baseNoSlash, missingSrc);
      const img = getAvatar(src);
      if ("loading" in img) img.loading = "eager";
    }
  }, [visibleAccounts]);

  // Build nodes for simulation
  const nodesRef = useRef([]);
  const simRef = useRef(null);
  const transformRef = useRef({ tx: 0, ty: 0, s: 1 });
  const avatarCacheRef = useRef(new Map());
  const glowCacheRef = useRef(new Map());
  const drawRef = useRef(() => {});

  const camRef = useRef({ scaleMul: 1, panX: 0, panY: 0 });
  const fitRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const isPanningRef = useRef(false);
  const zoomCuePlayedRef = useRef(false);
  const zoomCueRafRef = useRef(0);
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
    if (!visibleAccounts.length) return;
    if (w < 10 || h < 10) return;

    const base = getBase();
    const baseNoSlash = base.replace(/\/$/, "");
    const missingSrc = `${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`;
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
      missingImg.addEventListener("load", () => drawRef.current());
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
          if (img.src !== missingSrc) img.src = missingSrc;
          cache.set(url, missingImg);
          drawRef.current();
        };
        img.addEventListener("load", () => drawRef.current());
        img.addEventListener("error", () => handleError(true));
        // If preload finished before listeners were attached, recover immediately.
        if (img.complete) {
          if (img.naturalWidth > 0) drawRef.current();
          else handleError(false);
        }
      }
    });

    // Stop old sim
    if (simRef.current) simRef.current.stop();

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

    // Pre-tick offscreen so first paint is settled; then stop (static layout, no ongoing CPU)
    sim.alpha(1).restart();
    for (let i = 0; i < 180; i++) sim.tick();
    if (!plebsMode) {
      normalizeIslandEdgeGaps(nodes, labelsRef.current, Math.max(16, (regions?.gapPx || 12) * 0.85), 0.5);
    }
    sim.stop();

    sim.on("tick", () => {
      draw();
      if (sim.alpha() < 0.01) sim.stop();
    });

    draw();

    return () => {
      sim.stop();
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, err, visibleAccounts.length, w, h, plebsMode, equalAvatarSizeEnabled]);

  // On resize: recompute stance regions and update forces
  useEffect(() => {
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
  }, [w, h]);

  // On stance change: recompute regions, update forces, run short reflow then stop (keeps layout static, no lag)
  useEffect(() => {
    labelsRef.current = labels;
    const sim = simRef.current;
    const nodes = nodesRef.current;
    if (sim && nodes && nodes.length > 0) {
      const regions = computeStanceRegions(nodes, labels, w);
      regionRef.current = regions;
      const stanceCenterX = regions
        ? (d) => regions.stanceCenterX[getNodeStance(d, labels)] ?? w / 2
        : () => w / 2;
      sim.force("stanceX", forceX(stanceCenterX).strength(0.11));
      sim.alpha(0.8).restart();
      for (let i = 0; i < 90; i++) sim.tick();
      normalizeIslandEdgeGaps(nodes, labels, Math.max(16, (regions?.gapPx || 12) * 0.85), 0.5);
      sim.stop();
    }
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHandle]);

  useEffect(() => {
    return () => {
      if (zoomCueRafRef.current) cancelAnimationFrame(zoomCueRafRef.current);
    };
  }, []);

  useEffect(() => {
    if (zoomCuePlayedRef.current) return;
    if (loading || err) return;
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
  }, [loading, err, visibleAccounts.length, w, h]);

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

  function draw() {
    drawRef.current = draw;

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

    if (!nodes || nodes.length === 0) return;

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
      const missingSrc = `${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`;
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
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.brandWrap}>
            <div style={styles.title}>Consensus Health</div>
            <span style={styles.bipTag}>bip110</span>
          </div>
          <div style={styles.searchWrap}>
            <input
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
                    const fallback = `${getBase()}/avatars/_missing.svg?v=${AVATAR_REV}`;
                    if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback;
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
          {!me?.authenticated ? (
            <button style={styles.btn} onClick={beginLogin}>
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
          ) : (
            <>
              <div ref={adminOptionsRef} style={styles.optionsWrap}>
                <button
                  style={styles.btn}
                  onClick={() => setAdminOptionsOpen((v) => !v)}
                  disabled={authBusy}
                  title="Options"
                >
                  Options
                </button>
                {adminOptionsOpen && (
                  <div style={styles.optionsMenu}>
                    {isPrivilegedEditor && (
                      <label style={styles.optionsItem}>
                        <input
                          type="checkbox"
                          checked={manualEditMode}
                          onChange={(e) => setManualEditMode(e.target.checked)}
                        />
                        <span>Edit stances</span>
                        <span style={styles.optionsState}>{manualEditMode ? "ON" : "OFF"}</span>
                      </label>
                    )}
                    <label style={styles.optionsItem}>
                      <input
                        type="checkbox"
                        checked={plebsMode}
                        onChange={(e) => setPlebsMode(e.target.checked)}
                      />
                      <span>Plebs (&lt;3k followers)</span>
                      <span style={styles.optionsState}>{plebsMode ? "ON" : "OFF"}</span>
                    </label>
                    <label style={styles.optionsItem}>
                      <input
                        type="checkbox"
                        checked={equalAvatarSizeEnabled}
                        onChange={(e) => setEqualAvatarSizePreference(e.target.checked)}
                      />
                      <span>Equal avatar size</span>
                      <span style={styles.optionsState}>{equalAvatarSizeEnabled ? "ON" : "OFF"}</span>
                    </label>
                  </div>
                )}
              </div>
              <div style={styles.userChip}>
                <img
                  src={me.avatar_url || `${getBase()}/avatars/_missing.svg`}
                  alt={`@${me.handle}`}
                  loading="eager"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    const fallback = `${getBase()}/avatars/_missing.svg?v=${AVATAR_REV}`;
                    if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback;
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
                <span style={styles.stanceLabel}>@{me.handle}</span>
              </div>
              <button
                className={`stanceGlow stance-red ${meStance === "against" ? "aura aura-red" : ""}`}
                style={{
                  ...styles.pill,
                  borderColor: "rgba(220,38,38,0.55)",
                  opacity: meStance === "against" ? 1 : 0.72,
                  ...(meStance === "against" ? pillActiveStyle("against") : null),
                }}
                onClick={() => setMyStance("against")}
                disabled={authBusy}
              >
                Against
              </button>
              <button
                className={`stanceGlow stance-gray ${meStance === "neutral" ? "aura aura-gray" : ""}`}
                style={{
                  ...styles.pill,
                  borderColor: "rgba(156,163,175,0.65)",
                  opacity: meStance === "neutral" ? 1 : 0.72,
                  ...(meStance === "neutral" ? pillActiveStyle("neutral") : null),
                }}
                onClick={() => setMyStance("neutral")}
                disabled={authBusy}
              >
                Neutral
              </button>
              <button
                className={`stanceGlow stance-green ${meStance === "approve" ? "aura aura-green" : ""}`}
                style={{
                  ...styles.pill,
                  borderColor: "rgba(34,197,94,0.55)",
                  opacity: meStance === "approve" ? 1 : 0.72,
                  ...(meStance === "approve" ? pillActiveStyle("support") : null),
                }}
                onClick={() => setMyStance("support")}
                disabled={authBusy}
              >
                Approve
              </button>
              <button style={styles.btn} onClick={logout} disabled={authBusy}>Logout</button>
            </>
          )}
        </div>
      </div>

      <div style={styles.main}>
        <div ref={containerRef} style={styles.canvasWrap}>
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
        </div>
      </div>
      <div style={styles.footerNote}>
        <div>Stances are self-reported or curated.</div>
        <div>Size of avatars is proportional to number of followers.</div>
      </div>
      <div style={styles.bottomControls}>
        <button type="button" style={styles.bottomControlBtn} onClick={() => setShowStatsModal(true)}>Stats</button>
        <button type="button" style={styles.bottomControlBtn} onClick={() => setShowDonateModal(true)}>Donate</button>
        {stancePlaybackSequenceCount > 0 ? (
          <button
            type="button"
            style={styles.bottomControlBtn}
            onClick={() => (historyPlaybackPlaying ? stopHistoryPlayback() : beginHistoryPlayback())}
          >
            {historyPlaybackPlaying ? "Stop" : historyPlaybackHasFinishedOnce ? "Replay History" : "Play History"}
          </button>
        ) : null}
      </div>
      <StatisticsModal
        open={showStatsModal}
        onClose={() => setShowStatsModal(false)}
        data={statisticsData}
        loading={statsLoading}
        error={statsError}
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
                  const fallback = `${getBase()}/avatars/_missing.svg?v=${AVATAR_REV}`;
                  if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback;
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
                const fallback = `${getBase()}/avatars/_missing.svg?v=${AVATAR_REV}`;
                if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback;
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
                <BitcoinQr value={`bitcoin:${donationAddress}`} size={220} />
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
  },
  header: {
    position: "relative",
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
    padding: "3px 7px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(30,41,59,0.72)",
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
  },
  search: {
    width: 260,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.2)",
    outline: "none",
    background: "rgba(30,41,59,0.8)",
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
    gap: 10,
    alignItems: "center",
    background: "rgba(18,22,35,0.55)",
    padding: "6px 10px",
    borderRadius: 12,
    backdropFilter: "blur(6px)",
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
