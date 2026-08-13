/**
 * Graceful HTTP + Postgres shutdown on SIGTERM/SIGINT.
 */

import type { Server } from "node:http";
import type { Pool } from "pg";

export type GracefulShutdownOptions = {
  /** Drain timeout before force-close. Default 10s. */
  drainTimeoutMs?: number;
  signals?: NodeJS.Signals[];
  log?: (message: string, meta?: Record<string, unknown>) => void;
  onExit?: (code: number) => void;
};

/**
 * Register SIGTERM/SIGINT handlers that stop accepting connections, wait for
 * in-flight requests (up to drainTimeoutMs), then close the DB pool.
 */
export function gracefulShutdown(
  server: Server,
  pool: Pool,
  opts: GracefulShutdownOptions = {}
): () => void {
  const drainTimeoutMs = opts.drainTimeoutMs ?? 10_000;
  const signals = opts.signals ?? ["SIGTERM", "SIGINT"];
  const log = opts.log ?? ((msg, meta) => console.log(msg, meta ?? ""));
  const onExit = opts.onExit ?? ((code) => process.exit(code));

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("[shutdown] signal received", { signal, drainTimeoutMs });

    const forceTimer = setTimeout(() => {
      log("[shutdown] drain timeout exceeded; forcing exit");
      onExit(1);
    }, drainTimeoutMs);
    forceTimer.unref?.();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log("[shutdown] http server closed");
    } catch (err) {
      log("[shutdown] http server close error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await pool.end();
      log("[shutdown] db pool closed");
    } catch (err) {
      log("[shutdown] db pool close error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    clearTimeout(forceTimer);
    onExit(0);
  };

  const handlers = signals.map((signal) => {
    const handler = () => {
      void shutdown(signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  };
}
