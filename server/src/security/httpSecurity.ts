/**
 * Helmet / HTTP security headers for ConsensusHealth.
 *
 * CSP notes for Vite SPA:
 * - script-src 'self' only (no unsafe-eval).
 * - style-src includes 'unsafe-inline' because React may emit inline style attributes
 *   (and some Vite-injected critical CSS patterns rely on inline styles). Prefer
 *   nonces/hashes later if the SPA stops needing unsafe-inline styles.
 */

import helmet from "helmet";
import type { RequestHandler } from "express";

export type CreateHelmetOptions = {
  isProd: boolean;
  /**
   * When false, skip HSTS and upgrade-insecure-requests (e.g. HTTP E2E while
   * still using production-equivalent CSP). Defaults to `isProd`.
   */
  enforceHttpsRedirects?: boolean;
};

export function createHelmetMiddleware(opts: CreateHelmetOptions): RequestHandler {
  const enforceHttps = opts.enforceHttpsRedirects ?? opts.isProd;
  return helmet({
    // CSP compatible with the Vite-built SPA + X/Twitter avatar hosts.
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://pbs.twimg.com",
          "https://abs.twimg.com",
        ],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Explicitly omit unsafe-eval; helmet defaults already avoid it.
        upgradeInsecureRequests: enforceHttps ? [] : null,
      },
    },
    // OAuth popup login needs to window.close / postMessage to opener.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    // HSTS only behind real HTTPS (not HTTP E2E).
    hsts: enforceHttps
      ? {
          maxAge: 15552000, // 180 days
          includeSubDomains: true,
          preload: false,
        }
      : false,
    // X-Powered-By is removed by helmet; callers should also app.disable("x-powered-by").
    hidePoweredBy: true,
    frameguard: { action: "deny" },
    noSniff: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: "none" },
  });
}

/** Permissions-Policy header value (helmet does not set a full default). */
export const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";

export function createPermissionsPolicyMiddleware(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
    next();
  };
}
