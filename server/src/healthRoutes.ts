/**
 * Liveness and readiness endpoints. No secrets in responses.
 */

import type { Request, Response, NextFunction, Router } from "express";
import express from "express";
import type { Pool } from "pg";

export const HEALTH_SERVICE_NAME = "consensushealth-api";

export type HealthRoutesDeps = {
  pool: Pool;
  /** Ready check timeout in ms. Default 2000. */
  readyTimeoutMs?: number;
  serviceName?: string;
  now?: () => Date;
};

export function createHealthRouter(deps: HealthRoutesDeps): Router {
  const router = express.Router();
  const service = deps.serviceName ?? HEALTH_SERVICE_NAME;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 2000;
  const now = deps.now ?? (() => new Date());

  router.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service,
      time: now().toISOString(),
    });
  });

  router.get("/ready", async (_req: Request, res: Response, _next: NextFunction) => {
    try {
      await withTimeout(deps.pool.query("SELECT 1 AS ok"), readyTimeoutMs);
      res.status(200).json({
        ok: true,
        service,
        time: now().toISOString(),
      });
    } catch {
      // Never leak stack traces or connection strings.
      res.status(503).json({
        ok: false,
        service,
        error: "not_ready",
        time: now().toISOString(),
      });
    }
  });

  return router;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ready_timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
