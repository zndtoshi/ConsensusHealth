/**
 * CORS origin allowlist for ConsensusHealth.
 * Production: only validated HTTPS origins from APP_ORIGIN / APP_URL (+ www variants).
 * Never auto-allows http://localhost:5173 in production.
 */

import type { CorsOptions } from "cors";

export type EnvLike = Record<string, string | undefined>;

const DEV_LOCALHOST_ORIGIN = "http://localhost:5173";

function withWwwVariant(origin: string): string[] {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    if (host.startsWith("www.")) {
      const noWww = host.slice(4);
      return [origin, `${url.protocol}//${noWww}${port}`];
    }
    return [origin, `${url.protocol}//www.${host}${port}`];
  } catch {
    return [origin];
  }
}

function isValidHttpsOrigin(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && Boolean(u.hostname);
  } catch {
    return false;
  }
}

function isValidHttpOrHttpsOrigin(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Build the CORS origin allowlist from env.
 * Production only includes validated HTTPS APP_ORIGIN / APP_URL (+ www variants).
 * Development also allows localhost:5173 and configured http(s) origins.
 */
export function buildCorsOriginAllowlist(
  env: EnvLike,
  opts: { isProd: boolean }
): Set<string> {
  const set = new Set<string>();
  const addConfigured = (value: string): void => {
    const v = value.trim().replace(/\/+$/, "");
    if (!v) return;
    if (opts.isProd) {
      if (!isValidHttpsOrigin(v)) return;
    } else if (!isValidHttpOrHttpsOrigin(v)) {
      return;
    }
    for (const item of withWwwVariant(v)) set.add(item.replace(/\/+$/, ""));
  };

  addConfigured(String(env.APP_ORIGIN || ""));
  addConfigured(String(env.APP_URL || ""));

  if (!opts.isProd) {
    set.add(DEV_LOCALHOST_ORIGIN);
  }

  return set;
}

export type CreateCorsOptionsArgs = {
  env: EnvLike;
  isProd: boolean;
  /** Optional precomputed allowlist; otherwise built from env. */
  allowlist?: Set<string>;
};

/**
 * Express cors() options with credentials and allowlist check.
 */
export function createCorsOptions(args: CreateCorsOptionsArgs): CorsOptions {
  const allowlist = args.allowlist ?? buildCorsOriginAllowlist(args.env, { isProd: args.isProd });

  return {
    origin(origin, callback) {
      // Non-browser / same-origin requests may omit Origin.
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowlist.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  };
}
