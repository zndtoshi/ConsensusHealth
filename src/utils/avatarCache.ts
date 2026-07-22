import { isPerfDebugEnabled, perfInc } from "./perfDebug.js";

const avatarCache = new Map<string, HTMLImageElement>();
/** Temporary failure cache: URL → expiry timestamp (ms). */
const avatarFailureCache = new Map<string, number>();
let emptyAvatarImage: HTMLImageElement | null = null;

const FAILURE_TTL_MS = 30_000;
const DEFAULT_CONCURRENCY = 12;

function getEmptyAvatarImage(): HTMLImageElement {
  if (!emptyAvatarImage) {
    emptyAvatarImage =
      typeof Image !== "undefined" ? new Image() : ({} as HTMLImageElement);
  }
  return emptyAvatarImage;
}

type Priority = number; // lower = sooner
type Job = { key: string; img: HTMLImageElement; priority: Priority };

let concurrency = DEFAULT_CONCURRENCY;
let inFlight = 0;
const waitQueue: Job[] = [];
const waitingKeys = new Set<string>();

/**
 * Normalize avatar URL for deduping in-memory cache and stable browser cache keys.
 */
export function canonicalAvatarSrc(src: string): string {
  const s = String(src ?? "").trim();
  if (!s) return s;
  if (typeof window === "undefined" || !window.location?.href) {
    try {
      const u = new URL(s, "http://local.invalid/");
      u.hash = "";
      if (u.origin === "http://local.invalid") {
        return `${u.pathname}${u.search}`;
      }
      return u.href;
    } catch {
      return s;
    }
  }
  try {
    const u = new URL(s, window.location.href);
    u.hash = "";
    return u.href;
  } catch {
    return s;
  }
}

function failureActive(key: string): boolean {
  const until = avatarFailureCache.get(key);
  if (until == null) return false;
  if (Date.now() >= until) {
    avatarFailureCache.delete(key);
    return false;
  }
  return true;
}

function markFailure(key: string): void {
  avatarFailureCache.set(key, Date.now() + FAILURE_TTL_MS);
  if (isPerfDebugEnabled()) perfInc("avatarDecodeFail");
}

async function decodeImage(img: HTMLImageElement): Promise<void> {
  if (typeof img.decode !== "function") return;
  try {
    await img.decode();
    if (isPerfDebugEnabled()) perfInc("avatarDecodeOk");
  } catch {
    /* load/error already reflect outcome */
  }
}

function srcAssigned(img: HTMLImageElement): boolean {
  return img.getAttribute("data-ch-src") === "1";
}

function pump(): void {
  waitQueue.sort((a, b) => a.priority - b.priority);
  while (inFlight < concurrency && waitQueue.length > 0) {
    const job = waitQueue.shift();
    if (!job) break;
    waitingKeys.delete(job.key);
    if (srcAssigned(job.img)) continue;

    job.img.setAttribute("data-ch-src", "1");
    inFlight += 1;
    if (isPerfDebugEnabled()) perfInc("avatarNetworkLoads");

    const finish = (ok: boolean) => {
      inFlight = Math.max(0, inFlight - 1);
      if (ok) {
        avatarFailureCache.delete(job.key);
        void decodeImage(job.img).finally(() => pump());
      } else {
        markFailure(job.key);
        pump();
      }
    };

    job.img.addEventListener("load", () => finish(true), { once: true });
    job.img.addEventListener("error", () => finish(false), { once: true });
    if (job.img.complete && job.img.src) {
      // Already loaded (e.g. browser memory cache assigned elsewhere).
      finish(job.img.naturalWidth > 0);
      continue;
    }
    job.img.src = job.key;
  }
}

function enqueue(key: string, img: HTMLImageElement, priority: Priority): void {
  if (srcAssigned(img) || waitingKeys.has(key)) {
    // Allow priority bump for waiting jobs.
    if (waitingKeys.has(key)) {
      const existing = waitQueue.find((j) => j.key === key);
      if (existing && priority < existing.priority) existing.priority = priority;
    }
    return;
  }
  waitingKeys.add(key);
  waitQueue.push({ key, img, priority });
  pump();
}

/**
 * Returns a cached Image immediately (may still be loading). Dedupes by URL.
 * Never creates a new Image per render frame once cached.
 */
export function getAvatar(src: string): HTMLImageElement {
  return getAvatarPrioritized(src, 50);
}

/**
 * Shared Image handle with concurrency-limited network assign.
 * Lower `priority` loads sooner. Does not block on decode of other images.
 */
export function getAvatarPrioritized(src: string, priority: Priority = 50): HTMLImageElement {
  const key = canonicalAvatarSrc(src);
  if (!key) return getEmptyAvatarImage();
  if (isPerfDebugEnabled()) perfInc("avatarRequests");

  if (failureActive(key)) {
    if (isPerfDebugEnabled()) perfInc("avatarCacheHits");
    return getEmptyAvatarImage();
  }

  const existing = avatarCache.get(key);
  if (existing) {
    if (isPerfDebugEnabled()) perfInc("avatarCacheHits");
    if (!srcAssigned(existing)) enqueue(key, existing, priority);
    return existing;
  }

  const img = new Image();
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  if ("loading" in img) img.loading = "eager";
  avatarCache.set(key, img);
  enqueue(key, img, priority);
  return img;
}

/**
 * Preload a bounded list of avatar URLs; dedupes and respects concurrency.
 * Does not await the full set — each image decodes independently.
 */
export function preloadAvatarUrls(
  urls: readonly string[],
  opts?: { eager?: boolean; priority?: Priority }
): void {
  const seen = new Set<string>();
  const priority = opts?.priority ?? 50;
  for (const u of urls) {
    const k = canonicalAvatarSrc(String(u ?? "").trim());
    if (!k || seen.has(k)) continue;
    seen.add(k);
    getAvatarPrioritized(k, priority);
  }
}

export function setAvatarLoadConcurrency(n: number): void {
  concurrency = Math.max(1, Math.min(32, Math.floor(n) || DEFAULT_CONCURRENCY));
  pump();
}

export function getAvatarLoadConcurrency(): number {
  return concurrency;
}

export function hasCachedAvatar(src: string): boolean {
  const key = canonicalAvatarSrc(src);
  const img = avatarCache.get(key);
  return Boolean(img && img.complete && img.naturalWidth > 0);
}

export function getAvatarCacheSize(): number {
  return avatarCache.size;
}

/** Test helper: reset module caches. */
export function __resetAvatarCacheForTests(): void {
  avatarCache.clear();
  avatarFailureCache.clear();
  waitQueue.length = 0;
  waitingKeys.clear();
  inFlight = 0;
  concurrency = DEFAULT_CONCURRENCY;
  emptyAvatarImage = null;
}
