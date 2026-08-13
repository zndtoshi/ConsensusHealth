/**
 * Validated client IP for rate limiting behind Cloudflare → Render.
 *
 * Production topologies (pick exactly one via TRUST_PROXY_MODE):
 *
 * - `render_direct` (default): trust the single Render reverse-proxy hop
 *   (`trust proxy = 1`). `req.ip` is the visitor (or last proxy Render saw).
 *   Do not enable CF-Connecting-IP.
 *
 * - `cloudflare_origin_lock`: Cloudflare adds a high-entropy shared secret
 *   header (CF_ORIGIN_SECRET / X-Origin-Verify). The Render origin rejects
 *   requests missing that secret (origin lockdown). Only then is
 *   CF-Connecting-IP accepted as the visitor IP. Spoofed CF-Connecting-IP
 *   from the open internet is rejected because the secret is absent.
 *
 * Local development uses `render_direct` semantics without startup fatals.
 */

import type { Request, RequestHandler } from "express";
import { ipKeyGenerator } from "express-rate-limit";

export type TrustProxyMode = "render_direct" | "cloudflare_origin_lock";

export type ClientIpConfig = {
  mode: TrustProxyMode;
  /** Hop count for Express trust proxy. */
  trustProxyHops: number;
  originSecret: string | null;
  originSecretHeader: string;
};

export type EnvLike = Record<string, string | undefined>;

const DEFAULT_ORIGIN_HEADER = "x-origin-verify";

export function resolveTrustProxyMode(env: EnvLike = process.env): TrustProxyMode {
  const raw = String(env.TRUST_PROXY_MODE || "render_direct")
    .trim()
    .toLowerCase();
  if (raw === "cloudflare_origin_lock" || raw === "cloudflare") {
    return "cloudflare_origin_lock";
  }
  return "render_direct";
}

export function resolveClientIpConfig(
  env: EnvLike = process.env,
  opts?: { isProd?: boolean }
): { config: ClientIpConfig; fatal: string[]; warnings: string[] } {
  const isProd = Boolean(opts?.isProd);
  const fatal: string[] = [];
  const warnings: string[] = [];
  const mode = resolveTrustProxyMode(env);
  const originSecret = String(env.CF_ORIGIN_SECRET || env.ORIGIN_VERIFY_SECRET || "").trim();
  const originSecretHeader = String(env.CF_ORIGIN_SECRET_HEADER || DEFAULT_ORIGIN_HEADER)
    .trim()
    .toLowerCase() || DEFAULT_ORIGIN_HEADER;

  if (mode === "cloudflare_origin_lock") {
    if (!originSecret || originSecret.length < 32) {
      const msg =
        "TRUST_PROXY_MODE=cloudflare_origin_lock requires CF_ORIGIN_SECRET (or ORIGIN_VERIFY_SECRET) ≥ 32 characters";
      if (isProd) fatal.push(msg);
      else warnings.push(msg);
    }
  } else if (originSecret) {
    warnings.push(
      "CF_ORIGIN_SECRET is set but TRUST_PROXY_MODE is render_direct — secret header is ignored; CF-Connecting-IP will not be trusted"
    );
  }

  const config: ClientIpConfig = {
    mode,
    trustProxyHops: 1,
    originSecret: originSecret || null,
    originSecretHeader,
  };
  return { config, fatal, warnings };
}

export function assertClientIpConfig(
  env: EnvLike,
  opts: { isProd: boolean; throwOnFatal?: boolean; exit?: (code: number) => never }
): ClientIpConfig {
  const { config, fatal, warnings } = resolveClientIpConfig(env, { isProd: opts.isProd });
  for (const w of warnings) console.warn(`[clientIp] ${w}`);
  if (fatal.length) {
    const msg = fatal.join("; ");
    if (opts.throwOnFatal) throw new Error(msg);
    console.error(`[clientIp] ${msg}`);
    (opts.exit ?? process.exit)(1);
  }
  return config;
}

function headerValue(req: Request, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return String(raw[0] || "").trim();
  return String(raw || "").trim();
}

function firstForwardedIp(xff: string): string | null {
  const part = xff.split(",")[0]?.trim() || "";
  return part || null;
}

function looksLikeIp(value: string): boolean {
  // Basic IPv4 / IPv6 shape check (not full RFC validation).
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return true;
  if (value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value)) return true;
  return false;
}

/**
 * Resolve the visitor IP for rate limiting using the configured topology.
 * Never trusts CF-Connecting-IP or X-Forwarded-For without origin lock.
 */
export function getValidatedClientIp(req: Request, config: ClientIpConfig): string {
  const socketIp = req.socket?.remoteAddress || "unknown";

  if (config.mode === "cloudflare_origin_lock" && config.originSecret) {
    const provided = headerValue(req, config.originSecretHeader);
    if (provided && provided === config.originSecret) {
      const cfIp = headerValue(req, "cf-connecting-ip");
      if (cfIp && looksLikeIp(cfIp)) return cfIp;
      // Secret present but CF header missing — fall back to Express-trusted req.ip.
      const fallback = String(req.ip || socketIp || "unknown");
      return fallback;
    }
    // Missing/wrong secret: treat as direct-to-origin; ignore spoofable headers.
    return socketIp;
  }

  // render_direct: Express trust proxy hop yields visitor IP in req.ip.
  return String(req.ip || socketIp || "unknown");
}

export function clientIpRateLimitKey(req: Request, config: ClientIpConfig): string {
  return ipKeyGenerator(getValidatedClientIp(req, config));
}

/** Paths that must remain reachable for platform health probes without the CF secret. */
const ORIGIN_LOCK_EXEMPT_PATHS = new Set(["/api/health", "/api/ready"]);

/** Reject Cloudflare-locked production traffic that lacks the origin secret. */
export function createOriginLockMiddleware(config: ClientIpConfig): RequestHandler {
  return (req, res, next) => {
    if (config.mode !== "cloudflare_origin_lock" || !config.originSecret) {
      next();
      return;
    }
    const pathOnly = String(req.path || req.url || "").split("?")[0] || "";
    if (ORIGIN_LOCK_EXEMPT_PATHS.has(pathOnly)) {
      next();
      return;
    }
    const provided = headerValue(req, config.originSecretHeader);
    if (provided && provided === config.originSecret) {
      next();
      return;
    }
    res.status(403).json({
      error: "origin_forbidden",
      message: "Direct origin access is not allowed.",
    });
  };
}

/** Exported for tests — parse first XFF entry without trusting it in production paths. */
export function parseFirstXffForTests(xff: string): string | null {
  return firstForwardedIp(xff);
}
