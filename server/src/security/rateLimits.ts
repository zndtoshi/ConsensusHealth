/**
 * Rate limiters for ConsensusHealth API routes.
 *
 * Launch posture: in-memory store is intentionally single-instance.
 * Authenticated account quotas are NOT safe across multiple instances until a
 * shared store (e.g. Redis) is configured — see docs/launch-runbook.md.
 *
 * Authenticated write routes apply TWO independent limiters:
 *  1. IP/client limit
 *  2. authenticated X-user-ID limit (no IP in the key)
 * Both must pass. Changing IP does not reset the account quota and vice versa.
 *
 * Proxy note: `trust proxy = 1` trusts the single hop in front of the Node
 * process (Render's reverse proxy). When Cloudflare sits in front of Render,
 * req.ip is typically the Cloudflare edge unless the origin is locked down and
 * an additional trusted hop is configured. Do not enable trusting
 * CF-Connecting-IP on an origin that is publicly reachable without Cloudflare.
 */

import rateLimit, {
  ipKeyGenerator,
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import type { Request, RequestHandler } from "express";

export const RATE_LIMITED_BODY = {
  error: "rate_limited",
  message: "Too many requests. Please wait and try again.",
} as const;

/** Documented launch constraint for operators / tests. */
export const RATE_LIMIT_STORE_MODE = "memory_single_instance" as const;

export type RateLimitFactoryOptions = {
  store?: Options["store"];
  windowMs?: number;
  max?: number;
  getXUserId?: (req: Request) => string | null | undefined;
  /** Override IP key (validated client IP). Defaults to Express req.ip. */
  getClientIpKey?: (req: Request) => string;
};

function baseOptions(partial: Partial<Options> & Pick<Options, "windowMs" | "max">): Partial<Options> {
  return {
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, _next, optionsUsed) => {
      const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfterSec = reset
        ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000))
        : Math.ceil(optionsUsed.windowMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(optionsUsed.statusCode).json(RATE_LIMITED_BODY);
    },
    ...partial,
  };
}

function makeLimiter(
  defaults: { windowMs: number; max: number },
  opts?: RateLimitFactoryOptions,
  keyGenerator?: Options["keyGenerator"]
): RateLimitRequestHandler {
  return rateLimit(
    baseOptions({
      windowMs: opts?.windowMs ?? defaults.windowMs,
      max: opts?.max ?? defaults.max,
      store: opts?.store,
      keyGenerator,
    }) as Options
  );
}

export function ipKey(req: Request, getClientIpKey?: RateLimitFactoryOptions["getClientIpKey"]): string {
  if (typeof getClientIpKey === "function") return getClientIpKey(req);
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return ipKeyGenerator(ip);
}

export function accountKey(req: Request, getXUserId?: RateLimitFactoryOptions["getXUserId"]): string | null {
  const uid = String(getXUserId?.(req) ?? "").trim();
  return uid ? `uid:${uid}` : null;
}

/** General /api/* limiter — 120 requests / minute (IP). */
export function createGeneralApiRateLimiter(opts?: RateLimitFactoryOptions): RateLimitRequestHandler {
  return makeLimiter({ windowMs: 60_000, max: 120 }, opts, (req) => ipKey(req, opts?.getClientIpKey));
}

/** Auth routes — 20 / 15 minutes (IP). */
export function createAuthRateLimiter(opts?: RateLimitFactoryOptions): RateLimitRequestHandler {
  return makeLimiter({ windowMs: 15 * 60_000, max: 20 }, opts, (req) => ipKey(req, opts?.getClientIpKey));
}

/** /api/avatar-proxy — 60 / minute (IP). */
export function createAvatarProxyRateLimiter(opts?: RateLimitFactoryOptions): RateLimitRequestHandler {
  return makeLimiter({ windowMs: 60_000, max: 60 }, opts, (req) => ipKey(req, opts?.getClientIpKey));
}

/** stats / history / playback / new-stances — 60 / minute (IP). */
export function createStatsReadRateLimiter(opts?: RateLimitFactoryOptions): RateLimitRequestHandler {
  return makeLimiter({ windowMs: 60_000, max: 60 }, opts, (req) => ipKey(req, opts?.getClientIpKey));
}

function createIpWriteLimiter(
  defaults: { windowMs: number; max: number },
  opts?: RateLimitFactoryOptions
): RateLimitRequestHandler {
  return makeLimiter(defaults, opts, (req) => ipKey(req, opts?.getClientIpKey));
}

function createAccountWriteLimiter(
  defaults: { windowMs: number; max: number },
  opts?: RateLimitFactoryOptions
): RequestHandler {
  const limiter = makeLimiter(defaults, opts, (req) => {
    const key = accountKey(req, opts?.getXUserId);
    // express-rate-limit requires a string; unused when skipped below.
    return key || "uid:anonymous";
  });
  return (req, res, next) => {
    const key = accountKey(req, opts?.getXUserId);
    if (!key) {
      next();
      return;
    }
    limiter(req, res, next);
  };
}

/** Dual independent limiters: [ipLimiter, accountLimiter]. */
export function createDualWriteRateLimiters(
  defaults: { windowMs: number; max: number },
  opts?: RateLimitFactoryOptions
): [RateLimitRequestHandler, RequestHandler] {
  return [createIpWriteLimiter(defaults, opts), createAccountWriteLimiter(defaults, opts)];
}

export function createStanceWriteRateLimiters(opts?: RateLimitFactoryOptions) {
  return createDualWriteRateLimiters({ windowMs: 15 * 60_000, max: 30 }, opts);
}

export function createStanceExplanationWriteRateLimiters(opts?: RateLimitFactoryOptions) {
  return createDualWriteRateLimiters({ windowMs: 15 * 60_000, max: 30 }, opts);
}

export function createAdminWriteRateLimiters(opts?: RateLimitFactoryOptions) {
  return createDualWriteRateLimiters({ windowMs: 15 * 60_000, max: 60 }, opts);
}

export function createAccountDeletionRateLimiters(opts?: RateLimitFactoryOptions) {
  return createDualWriteRateLimiters({ windowMs: 15 * 60_000, max: 10 }, opts);
}

/** @deprecated Prefer createStanceWriteRateLimiters (dual). Kept for test imports. */
export function createStanceWriteRateLimiter(opts?: RateLimitFactoryOptions): RateLimitRequestHandler {
  return createIpWriteLimiter({ windowMs: 15 * 60_000, max: 30 }, opts);
}

/** @deprecated Prefer createStanceExplanationWriteRateLimiters. */
export function createStanceExplanationWriteRateLimiter(
  opts?: RateLimitFactoryOptions
): RateLimitRequestHandler {
  return createIpWriteLimiter({ windowMs: 15 * 60_000, max: 30 }, opts);
}

/** @deprecated Prefer createAdminWriteRateLimiters. */
export function createAdminRateLimiter(opts?: RateLimitFactoryOptions): RateLimitRequestHandler {
  return createIpWriteLimiter({ windowMs: 15 * 60_000, max: 60 }, opts);
}

/** @deprecated Prefer createAccountDeletionRateLimiters. */
export function createAccountDeletionRateLimiter(
  opts?: RateLimitFactoryOptions
): RateLimitRequestHandler {
  return createIpWriteLimiter({ windowMs: 15 * 60_000, max: 10 }, opts);
}

export function buildIpRateLimitKey(
  req: Request,
  getClientIpKey?: RateLimitFactoryOptions["getClientIpKey"]
): string {
  return ipKey(req, getClientIpKey);
}

export function buildAccountRateLimitKey(
  req: Request,
  getXUserId?: RateLimitFactoryOptions["getXUserId"]
): string | null {
  return accountKey(req, getXUserId);
}

/** Legacy helper — returns account key when present, else IP (not dual). */
export function buildAuthWriteRateLimitKey(
  req: Request,
  getXUserId?: RateLimitFactoryOptions["getXUserId"]
): string {
  return accountKey(req, getXUserId) || ipKey(req);
}
