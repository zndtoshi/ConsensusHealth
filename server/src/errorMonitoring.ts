/**
 * Optional error monitoring hook.
 * Set SENTRY_DSN and install `@sentry/node` in production to enable.
 * Local development never requires it. Never send cookies, tokens, or profiles.
 */

export type ErrorMonitoringHandle = {
  captureException: (err: unknown, context?: Record<string, unknown>) => void;
};

const REDACT_KEYS = /cookie|authorization|password|secret|token|code_verifier|access_token|refresh_token|set-cookie|explanation|bio|email/i;

function redactContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = REDACT_KEYS.test(key) ? "[redacted]" : value;
  }
  return out;
}

export function createNoopErrorMonitor(): ErrorMonitoringHandle {
  return {
    captureException() {
      /* intentionally empty */
    },
  };
}

/**
 * Initialize optional monitoring. Without SENTRY_DSN (or without @sentry/node),
 * returns a no-op so local/dev stays dependency-light.
 */
export async function initErrorMonitoring(
  env: NodeJS.ProcessEnv = process.env
): Promise<ErrorMonitoringHandle> {
  const dsn = String(env.SENTRY_DSN || "").trim();
  if (!dsn) return createNoopErrorMonitor();

  try {
    const modName = "@sentry/node";
    // Optional peer dependency — resolved only when operators install it.
    const sentry = (await import(modName)) as {
      init?: (opts: Record<string, unknown>) => void;
      captureException?: (err: unknown, hint?: Record<string, unknown>) => void;
    };
    if (typeof sentry.init !== "function" || typeof sentry.captureException !== "function") {
      console.warn("[errorMonitoring] SENTRY_DSN set but @sentry/node is unavailable; using no-op");
      return createNoopErrorMonitor();
    }
    sentry.init({
      dsn,
      environment: env.NODE_ENV || "development",
      tracesSampleRate: Math.min(1, Math.max(0, Number(env.SENTRY_TRACES_SAMPLE_RATE || 0))),
      beforeSend(event: { request?: { cookies?: unknown; headers?: Record<string, string> } }) {
        if (event.request) {
          delete event.request.cookies;
          if (event.request.headers) {
            for (const key of Object.keys(event.request.headers)) {
              if (REDACT_KEYS.test(key)) event.request.headers[key] = "[redacted]";
            }
          }
        }
        return event;
      },
    });
    return {
      captureException(err, context) {
        const extra = redactContext(context);
        sentry.captureException?.(err, extra ? { extra } : undefined);
      },
    };
  } catch {
    console.warn("[errorMonitoring] SENTRY_DSN set but @sentry/node failed to load; using no-op");
    return createNoopErrorMonitor();
  }
}
