/**
 * Request ID + structured access logging with sensitive field redaction.
 */

import crypto from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

const REDACT_KEYS = new Set([
  "cookie",
  "cookies",
  "authorization",
  "proxy-authorization",
  "set-cookie",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "code",
  "code_verifier",
  "client_secret",
  "session",
  "password",
  "secret",
  "explanation",
  "tweet_text",
  "body_text",
  "text",
]);

export type RequestLogFields = {
  request_id: string;
  method: string;
  route: string;
  status: number;
  latency_ms: number;
  ip?: string;
};

export type RequestLoggingOptions = {
  /** Custom id generator (tests). */
  createId?: () => string;
  /** Sink for structured log lines. Defaults to console.log JSON. */
  log?: (fields: RequestLogFields & Record<string, unknown>) => void;
};

/** Bound + sanitize inbound x-request-id; generate a fresh id when invalid. */
export function sanitizeRequestId(raw: unknown, createId: () => string = () => crypto.randomUUID()): string {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 64) return createId();
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) return createId();
  return value;
}

export function createRequestIdMiddleware(opts?: RequestLoggingOptions): RequestHandler {
  const createId = opts?.createId ?? (() => crypto.randomUUID());
  return (req, res, next) => {
    const id = sanitizeRequestId(req.headers[REQUEST_ID_HEADER], createId);
    (req as Request & { requestId?: string }).requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

export function createRequestLoggingMiddleware(opts?: RequestLoggingOptions): RequestHandler {
  const log =
    opts?.log ??
    ((fields) => {
      console.log(JSON.stringify(fields));
    });

  return (req, res, next) => {
    const started = Date.now();
    const requestId =
      (req as Request & { requestId?: string }).requestId ||
      String(req.headers[REQUEST_ID_HEADER] || "") ||
      crypto.randomUUID();

    res.on("finish", () => {
      const route = resolveRoute(req);
      log({
        request_id: requestId,
        method: req.method,
        route,
        status: res.statusCode,
        latency_ms: Date.now() - started,
        ip: req.ip,
      });
    });

    next();
  };
}

function resolveRoute(req: Request): string {
  const base = req.baseUrl || "";
  const routePath = req.route?.path != null ? String(req.route.path) : req.path || req.url || "";
  const joined = `${base}${routePath}`.split("?")[0] || "/";
  return joined;
}

/**
 * Deep-redact sensitive keys from objects before logging (OAuth bodies, etc.).
 */
export function redactForLog(input: unknown, depth = 0): unknown {
  if (depth > 6) return "[MaxDepth]";
  if (input == null) return input;
  if (typeof input === "string") {
    if (looksLikeToken(input)) return "[REDACTED]";
    return input.length > 500 ? `${input.slice(0, 80)}…[truncated]` : input;
  }
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((v) => redactForLog(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (REDACT_KEYS.has(key) || key.includes("token") || key.includes("secret") || key.includes("authorization")) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (key === "explanation" || key.endsWith("_text") || key === "body") {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = redactForLog(v, depth + 1);
  }
  return out;
}

function looksLikeToken(value: string): boolean {
  if (value.length >= 40 && /^[A-Za-z0-9\-._~+/]+=*$/.test(value)) return true;
  if (/^Bearer\s+/i.test(value)) return true;
  return false;
}

/**
 * Redacted diagnostics helper for OAuth provider error bodies.
 */
export function logOAuthProviderFailure(
  label: string,
  status: number,
  bodyText: string,
  sink: (msg: string, meta?: Record<string, unknown>) => void = console.error
): void {
  sink(label, {
    status,
    body: redactForLog(safeParseOrSnippet(bodyText)),
  });
}

function safeParseOrSnippet(text: string): unknown {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.length > 200 ? `${trimmed.slice(0, 80)}…[truncated]` : trimmed;
  }
}

export function attachRequestLogging(app: {
  use: (...handlers: RequestHandler[]) => unknown;
}, opts?: RequestLoggingOptions): void {
  app.use(createRequestIdMiddleware(opts));
  app.use(createRequestLoggingMiddleware(opts));
}

export type { NextFunction };
