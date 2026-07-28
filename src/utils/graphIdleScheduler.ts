/**
 * Single idle halo/graph animation scheduler.
 * Throttles visually-idle full redraws and pauses while the document is hidden.
 * Interaction draws stay on the separate scheduleDraw / pointer path.
 */

export const IDLE_HALO_FPS = 15;

export type GraphIdleSchedulerHooks = {
  /** True when idle halo animation should run (cluster and/or breathing). */
  shouldAnimate: () => boolean;
  /** True while camera pan/pinch is active — skip idle draws. */
  isCameraInteracting: () => boolean;
  /** True while intro freezes the graph — skip idle draws. */
  isIntroFrozen: () => boolean;
  /** Coalesced draw request (existing scheduleDraw). */
  scheduleDraw: () => void;
  /** Optional immediate draw on visibility restore. */
  drawNow?: () => void;
  fps?: number;
  now?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
  getVisibilityState?: () => DocumentVisibilityState;
  addVisibilityListener?: (handler: () => void) => () => void;
};

export type GraphIdleScheduler = {
  start: () => void;
  stop: () => void;
  /** Test/inspection: whether an rAF loop is scheduled. */
  isRunning: () => boolean;
};

/**
 * Create one authority for idle halo redraws.
 * Does not touch React state; callers pass refs via closures.
 */
export function createGraphIdleScheduler(hooks: GraphIdleSchedulerHooks): GraphIdleScheduler {
  const fps = Math.max(1, Number(hooks.fps) || IDLE_HALO_FPS);
  const minIntervalMs = 1000 / fps;
  const nowFn = hooks.now || (() => performance.now());
  const rafFn =
    hooks.raf ||
    ((cb: FrameRequestCallback) =>
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : 0);
  const cafFn =
    hooks.caf ||
    ((id: number) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
    });
  const getVisibility =
    hooks.getVisibilityState ||
    (() => (typeof document !== "undefined" ? document.visibilityState : "visible"));

  let rafId = 0;
  /** Negative infinity so the first armed tick always qualifies for a draw. */
  let lastDrawAt = Number.NEGATIVE_INFINITY;
  let started = false;
  let removeVisibility: (() => void) | null = null;

  const clearRaf = () => {
    if (rafId) {
      cafFn(rafId);
      rafId = 0;
    }
  };

  const tick = (t: number) => {
    rafId = 0;
    if (!started) return;
    if (getVisibility() === "hidden") return;
    if (!hooks.shouldAnimate()) return;

    if (!hooks.isCameraInteracting() && !hooks.isIntroFrozen()) {
      if (t - lastDrawAt >= minIntervalMs) {
        lastDrawAt = t;
        hooks.scheduleDraw();
      }
    }

    rafId = rafFn(tick);
  };

  const arm = () => {
    if (!started) return;
    if (getVisibility() === "hidden") {
      clearRaf();
      return;
    }
    if (!hooks.shouldAnimate()) {
      clearRaf();
      return;
    }
    if (!rafId) rafId = rafFn(tick);
  };

  const onVisibility = () => {
    if (!started) return;
    if (getVisibility() === "hidden") {
      clearRaf();
      return;
    }
    // One immediate draw when returning to the tab, then resume idle cadence.
    lastDrawAt = Number.NEGATIVE_INFINITY;
    hooks.scheduleDraw();
    if (typeof hooks.drawNow === "function") hooks.drawNow();
    arm();
  };

  return {
    start() {
      if (started) return;
      started = true;
      lastDrawAt = Number.NEGATIVE_INFINITY;
      if (typeof hooks.addVisibilityListener === "function") {
        removeVisibility = hooks.addVisibilityListener(onVisibility);
      } else if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("visibilitychange", onVisibility);
        removeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
      }
      arm();
    },
    stop() {
      started = false;
      clearRaf();
      if (removeVisibility) {
        removeVisibility();
        removeVisibility = null;
      }
    },
    isRunning() {
      return started && rafId !== 0;
    },
  };
}
