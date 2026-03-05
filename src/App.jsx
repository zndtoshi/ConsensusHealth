import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { forceCollide, forceManyBody, forceCenter, forceSimulation, forceX, forceY } from "d3-force";
import { getAvatar } from "./utils/avatarCache";
import { fetchCommunityUsers } from "./api/community";

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

const LABELS_STORAGE_KEY = "consensushealth:bip110:labels:v1";
const GLOW_CACHE_VERSION = 3;
const AVATAR_REV = "20260305d";
const DATA_REV = "20260305d";
const API_BASE = ((import.meta.env && import.meta.env.VITE_API_BASE) || "").replace(/\/$/, "");

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
  const gapPx = Math.max(10, width * 0.01);
  // Tight band (~58% of width) so all three islands sit close together and feel cohesive
  const contentWidth = width * 0.58;
  const contentLeft = (width - contentWidth) / 2;
  const usable = contentWidth - 2 * gapPx;
  // Proportional widths with minimum per region so neutral is never a sliver (avoids scattered grey blob)
  const minFrac = 0.18;
  const rawRed = Math.max(usable * (redW / total), usable * minFrac);
  const rawGrey = Math.max(usable * (greyW / total), usable * minFrac);
  const rawGreen = Math.max(usable * (greenW / total), usable * minFrac);
  const sum = rawRed + rawGrey + rawGreen;
  const redWidth = usable * (rawRed / sum);
  const greyWidth = usable * (rawGrey / sum);
  const greenWidth = usable * (rawGreen / sum);
  const redStart = contentLeft;
  const redEnd = contentLeft + redWidth;
  const greyStart = redEnd + gapPx;
  const greyEnd = greyStart + greyWidth;
  const greenStart = greyEnd + gapPx;
  const greenEnd = contentLeft + contentWidth;
  const greyCxCurrent = greyStart + greyWidth / 2;
  const shift = width / 2 - greyCxCurrent;
  const redCx = redStart + redWidth / 2 + shift;
  const greyCx = width / 2;
  const greenCx = greenStart + greenWidth / 2 + shift;
  return {
    stanceCenterX: {
      [STANCE.AGAINST]: redCx,
      [STANCE.NEUTRAL]: greyCx,
      [STANCE.APPROVE]: greenCx,
    },
    redEnd: redEnd + shift,
    greyStart: greyStart + shift,
    greyEnd: greyEnd + shift,
    greenStart: greenStart + shift,
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

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

function createGlowSprite(aura, side, emphasize, quality = 1) {
  const layers = emphasize
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
  // Prevent clipping: pad must account for the largest blur radius.
  const maxBlur = layers.reduce((m, l) => Math.max(m, l.blur), 0);
  const padBase = clamp(side * (emphasize ? 5.2 : 4.6), 72, emphasize ? 560 : 460);
  const pad = Math.ceil(Math.max(padBase, maxBlur * 1.6));
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
  const map = new Map();
  for (const a of Array.isArray(seeded) ? seeded : []) {
    const handle = String(a.handle ?? "").trim().toLowerCase();
    if (!handle) continue;
    map.set(handle, { ...a, handle });
  }
  for (const c of Array.isArray(community) ? community : []) {
    const handle = String(c.handle ?? "").trim().toLowerCase();
    if (!handle) continue;
    if (map.has(handle)) {
      const prev = map.get(handle);
      map.set(handle, {
        ...prev,
        stance: normalizedStance(c.stance ?? prev.stance),
      });
    } else {
      map.set(handle, {
        handle,
        name: c.name ?? "",
        followers_count:
          c.followers_count == null ? 1000 : toInt(c.followers_count),
        stance: normalizedStance(c.stance),
        avatar_url: c.avatar_url ?? null,
        x_user_id: c.x_user_id ?? null,
      });
    }
  }
  const merged = Array.from(map.values());
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
  const [showDonateModal, setShowDonateModal] = useState(false);
  const [labels, setLabels] = useState(() => {
    try {
      const raw = localStorage.getItem(LABELS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const normalized = {};
      for (const [k, v] of Object.entries(parsed)) {
        const kk = String(k ?? "").trim().toLowerCase();
        if (!kk) continue;
        normalized[kk] = v;
      }
      return normalized;
    } catch {
      return {};
    }
  });
  const [dropdownHoverHandle, setDropdownHoverHandle] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(LABELS_STORAGE_KEY, JSON.stringify(labels));
    } catch {}
  }, [labels]);

  async function loadMe() {
    try {
      const res = await fetch(`${API_BASE}/api/me`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      const authenticated = Boolean(data && data.x_user_id);
      setMe(authenticated ? { authenticated: true, ...data } : { authenticated: false });
      if (authenticated && data?.handle && data?.stance) {
        setLabels((prev) => ({ ...prev, [String(data.handle).toLowerCase()]: normalizedStance(data.stance) }));
      }
    } catch {
      // ignore auth failures in local dev
    }
  }

  function beginLogin() {
    window.location.href = `${API_BASE}/auth/x`;
  }

  async function logout() {
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setMe(null);
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

  useEffect(() => {
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const meStance = me?.stance ? normalizedStance(me.stance) : "";
  const meHandleLower = safeLower(me?.handle);
  const donateAvatarSrc = useMemo(() => {
    const baseNoSlash = getBase().replace(/\/$/, "");
    const account = accounts.find((a) => safeLower(a.handle) === "zndtoshi");
    if (account?.avatar_path) return `${baseNoSlash}${account.avatar_path}?v=${AVATAR_REV}`;
    if (account?.avatar_url) return account.avatar_url;
    return `${baseNoSlash}/avatars/zndtoshi.jpg?v=${AVATAR_REV}`;
  }, [accounts]);

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
    for (const a of accounts) map.set(a.handle, 0);
    for (const [h, arr] of mentionsByHandle.entries()) map.set(h, arr.length);
    return map;
  }, [accounts, mentionsByHandle]);

  const filteredHandlesSet = useMemo(() => {
    const q = safeLower(search).trim();
    if (!q) return null;
    const s = new Set();
    for (const a of accounts) {
      if (safeLower(a.handle).includes(q)) s.add(a.handle);
      else if (safeLower(a.name).includes(q)) s.add(a.handle);
      else if (safeLower(a.bio_snippet).includes(q)) s.add(a.handle);
    }
    return s;
  }, [accounts, search]);

  const searchDropdownResults = useMemo(() => {
    const q = safeLower(search).trim();
    if (!q) return [];
    const out = [];
    for (const a of accounts) {
      const hasMatch =
        safeLower(a.handle).includes(q) ||
        safeLower(a.name).includes(q) ||
        safeLower(a.bio_snippet).includes(q);
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
  }, [accounts, search, tweetCountByHandle, labels]);

  const selectedTweets = useMemo(() => {
    if (!selectedHandle) return [];
    return mentionsByHandle.get(selectedHandle) || [];
  }, [mentionsByHandle, selectedHandle]);

  const visibleCount = useMemo(() => {
    return accounts.filter(
      (a) => (tweetCountByHandle.get(a.handle) || 0) > 0 || Boolean(getStanceForHandle(labels, a.handle))
    ).length;
  }, [accounts, tweetCountByHandle, labels]);

  // Backfill labels from account-provided stance fields, preserving existing stored values.
  useEffect(() => {
    if (!accounts.length) return;
    setLabels((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const a of accounts) {
        const h = (a.handle || "").trim().toLowerCase();
        if (!h) continue;
        if (next[h]) continue;
        const raw = String(a.stance ?? a.position ?? "").trim().toLowerCase();
        let mapped = "";
        if (raw === "against") mapped = STANCE.AGAINST;
        else if (raw === "support" || raw === "approve") mapped = STANCE.APPROVE;
        else if (raw === "neutral") mapped = STANCE.NEUTRAL;
        if (mapped) {
          next[h] = mapped;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [accounts]);

  // Preload avatars once accounts are available.
  useEffect(() => {
    if (!accounts.length) return;
    const base = getBase();
    const baseNoSlash = base.replace(/\/$/, "");
    const missingSrc = `${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`;
    getAvatar(missingSrc);
    for (const a of accounts) {
      const src = a.avatar_path
        ? `${baseNoSlash}${a.avatar_path}?v=${AVATAR_REV}`
        : (a.avatar_url || a.profile_image_url || missingSrc);
      const img = getAvatar(src);
      if ("loading" in img) img.loading = "eager";
    }
  }, [accounts]);

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
  const tooltipSelfRef = useRef(null);
  const avatarWarnedHandlesRef = useRef(new Set());
  const avatarHookedRef = useRef(new WeakSet());
  labelsRef.current = labels;
  selectedHandleRef.current = selectedHandle;

  // (Re)create simulation when size/data/shake changes
  useEffect(() => {
    if (loading || err) return;
    if (!accounts.length) return;
    if (w < 10 || h < 10) return;

    const base = getBase();
    const baseNoSlash = base.replace(/\/$/, "");
    const missingSrc = `${baseNoSlash}/avatars/_missing.svg?v=${AVATAR_REV}`;
    const avatarSrc = (a) =>
      a.avatar_path
        ? `${baseNoSlash}${a.avatar_path}?v=${AVATAR_REV}`
        : (a.avatar_url || a.profile_image_url || missingSrc);

    // Build nodes: accounts that tweeted about bip110, plus manually stance-labeled accounts
    const nodes = accounts
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
        const side = sideFromFollowers(followersForSize);
        return {
          handle: a.handle,
          seedStance,
          followers: rawFollowers,
          side,
          half: side / 2,
          tweetCount,
          avatarUrl: avatarSrc(a),
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
    const urlToHandles = new Map();
    for (const n of nodes) {
      if (!n.avatarUrl) continue;
      if (!urlToHandles.has(n.avatarUrl)) urlToHandles.set(n.avatarUrl, []);
      urlToHandles.get(n.avatarUrl).push(n.handle);
    }
    const missingImg = getAvatar(missingSrc);
    if ("loading" in missingImg) missingImg.loading = "eager";
    if (!hooked.has(missingImg)) {
      hooked.add(missingImg);
      missingImg.addEventListener("load", () => drawRef.current());
    }
    const urls = [...new Set(nodes.map((n) => n.avatarUrl).filter(Boolean))];
    urls.forEach((url) => {
      const img = getAvatar(url);
      if ("decoding" in img) img.decoding = "async";
      if ("loading" in img) img.loading = "eager";
      cache.set(url, img);
      if (!hooked.has(img)) {
        hooked.add(img);
        const handleError = () => {
          const handles = urlToHandles.get(url) || [];
          for (const handle of handles) {
            if (warnedHandles.has(handle)) continue;
            warnedHandles.add(handle);
            console.warn("Avatar failed", handle, url);
          }
          if (img.src !== missingSrc) img.src = missingSrc;
          cache.set(url, missingImg);
          drawRef.current();
        };
        img.addEventListener("load", () => drawRef.current());
        img.addEventListener("error", handleError);
        // If preload finished before listeners were attached, recover immediately.
        if (img.complete) {
          if (img.naturalWidth > 0) drawRef.current();
          else handleError();
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
      .force("stanceX", forceX(stanceCenterX).strength(0.11))
      .force("stanceBounds", forceStanceBounds(regionRef, labelsRef, 0.07))
      .force("pullY", forceY(h / 2).strength(0.03))
      .force("charge", forceManyBody().strength(-4))
      .force(
        "collide",
        forceCollide((d) => Math.sqrt(2) * d.half + 0.6).iterations(2)
      );

    simRef.current = sim;

    // Pre-tick offscreen so first paint is settled; then stop (static layout, no ongoing CPU)
    sim.alpha(1).restart();
    for (let i = 0; i < 180; i++) sim.tick();
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
  }, [loading, err, accounts.length, w, h]);

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
      sim.stop();
    }
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels]);

  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHandle]);

  function updateHoverOverlay(nextHover) {
    const tip = tooltipRef.current;
    if (!tip) return;
    if (!nextHover) {
      tip.style.display = "none";
      return;
    }
    const left = clamp(nextHover.x + 12, 8, Math.max(8, w - 260));
    const top = clamp(nextHover.y + 12, 8, Math.max(8, h - 90));
    tip.style.display = "block";
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    const isSelfHover = safeLower(nextHover.handle) === meHandleLower;
    if (tooltipHandleRef.current) tooltipHandleRef.current.textContent = `@${nextHover.handle}`;
    if (tooltipFollowersRef.current) {
      tooltipFollowersRef.current.textContent = `followers: ${formatNum(nextHover.followers)}`;
    }
    if (tooltipSelfRef.current) {
      tooltipSelfRef.current.style.display = isSelfHover ? "inline-block" : "none";
    }
  }

  // Drawing
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

    // Subtle starfield (screen space)
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    const starCount = isFirefox ? 48 : 120;
    for (let i = 0; i < starCount; i++) {
      const x = (i * 137.5 + 13) % (cw + 2);
      const y = (i * 97.3 + 17) % (ch + 2);
      const r = (i % 3 === 0) ? 1 : 0.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const nodes = nodesRef.current;
    const qset = filteredHandlesSet;
    const avatarCache = avatarCacheRef.current;

    if (!nodes || nodes.length === 0) return;

    const maxDrawScale = 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
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

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const radius = (side) => Math.min(14, side * 0.22);
    const glowQuality = isFirefox ? 0.62 : 1;
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
      const drawHalf = (n.side * scaleFactor) / 2;
      const drawX = n.x - drawHalf;
      const drawY = n.y - drawHalf;
      const drawSide = n.side * scaleFactor;
      const r = radius(drawSide);
      const isSelected = curSelected && n.handle === curSelected;
      const isHovered = curHover && n.handle === curHover.handle;
      const isInSearch = qset ? qset.has(n.handle) : true;
      const alpha = isInSearch ? 1 : 0.12;
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

    };

    const curHover = hoverRef.current;
    const curSelected = selectedHandleRef.current;
    const base = [], hovered = [], selected = [];
    const hoverScale = 1.14;
    const selectedScale = 2;
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
      ? { x: mx, y: my, handle: n.handle, followers: n.followers, tweetCount: n.tweetCount }
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
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <div style={styles.title}>ConsensusHealth</div>
          <div style={styles.sub}>Loading data…</div>
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={styles.page}>
        <div style={styles.header}>
          <div style={styles.title}>ConsensusHealth</div>
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
          <div style={styles.title}>ConsensusHealth</div>
          <div style={styles.searchWrap}>
            <input
              style={styles.search}
              placeholder="Search handle / name / bio…"
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
                    color: stanceHeaderColor(getStanceForHandle(labels, selectedHandle)),
                    textShadow: `0 1px 0 rgba(0,0,0,0.9), 0 0 8px ${stanceHeaderColor(getStanceForHandle(labels, selectedHandle))}, 0 0 18px ${stanceHeaderColor(getStanceForHandle(labels, selectedHandle))}`,
                  }}
                >
                  {getStanceForHandle(labels, selectedHandle) ? getStanceForHandle(labels, selectedHandle) : "unlabeled"}
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
              <div style={styles.userChip}>
                <img
                  src={me.avatar_url || `${getBase()}/avatars/_missing.svg`}
                  alt={`@${me.handle}`}
                  style={styles.userChipAvatar}
                />
                <span style={styles.stanceLabel}>@{me.handle}</span>
                <span style={styles.userChipStance}>
                  {meStance ? meStance.toUpperCase() : "UNSET"}
                </span>
              </div>
              <button
                style={{ ...styles.pill, borderColor: "rgba(220,38,38,0.55)", opacity: meStance === "against" ? 1 : 0.75 }}
                onClick={() => setMyStance("against")}
                disabled={authBusy}
              >
                Against
              </button>
              <button
                style={{ ...styles.pill, borderColor: "rgba(156,163,175,0.65)", opacity: meStance === "neutral" ? 1 : 0.75 }}
                onClick={() => setMyStance("neutral")}
                disabled={authBusy}
              >
                Neutral
              </button>
              <button
                style={{ ...styles.pill, borderColor: "rgba(34,197,94,0.55)", opacity: meStance === "approve" ? 1 : 0.75 }}
                onClick={() => setMyStance("support")}
                disabled={authBusy}
              >
                Support
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
            style={{ ...styles.canvas, touchAction: "none" }}
          />
          <div ref={tooltipRef} style={{ ...styles.tooltip, display: "none" }}>
            <div ref={tooltipHandleRef} style={{ fontWeight: 700 }} />
            <div ref={tooltipSelfRef} style={styles.tooltipSelf}>You</div>
            <div ref={tooltipFollowersRef} style={{ opacity: 0.9 }} />
          </div>
        </div>
      </div>
      <div style={styles.footerNote}>
        <div>Stances are self-reported or curated.</div>
        <div>Size of avatars is proportional to number of followers.</div>
      </div>
      <button style={styles.donateBtn} onClick={() => setShowDonateModal(true)}>Donate</button>
      {showDonateModal && (
        <div style={styles.modalBackdrop} onClick={() => setShowDonateModal(false)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <img src={donateAvatarSrc} alt="@zndtoshi" style={styles.donateProfileAvatar} />
            <a href="https://x.com/zndtoshi" target="_blank" rel="noreferrer" style={styles.donateHandleLink}>
              @zndtoshi
            </a>
            <img
              src={`${getBase()}/donate.png`}
              alt="Donate Bitcoin QR"
              style={styles.donateQr}
            />
            <div style={styles.donateAddr}>bc1qxum7h6z90ynk889j0vr9j7pasqxj9f7qgeqxq7</div>
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
    alignItems: "baseline",
    gap: 10,
  },
  selectedHandle: { fontWeight: 800, fontSize: 14, color: "#e2e8f0" },
  selectedHandleLink: {
    ...{
      fontWeight: 800,
      fontSize: 14,
      color: "#e2e8f0",
    },
    textDecoration: "none",
    cursor: "pointer",
  },
  selectedStanceBadge: { fontWeight: 900, fontSize: 24, letterSpacing: 0.4, lineHeight: 1, textTransform: "capitalize" },
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
  donateBtn: {
    position: "fixed",
    right: 12,
    bottom: 10,
    zIndex: 40,
    padding: "8px 12px",
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
