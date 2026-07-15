import {
  INTRO_FLIGHT_DURATION_MS,
  INTRO_FLIGHT_STAGGER_MS,
  INTRO_FLIGHT_PERF_SAMPLE_MS,
  INTRO_TIMING,
  buildFlightKeyframes,
  easeIntroFlight,
  type IntroItem,
  type StagingView,
} from "./newStancesIntro.js";

export type DebugNewStancesMotionParams = {
  enabled: boolean;
};

export type IntroFlightMotionReport = {
  measuredFps: number;
  longFramesAbove32Ms: number;
  flightDurationMs: number;
  flyingAvatarCount: number;
  simplifiedEffects: boolean;
  reducedMotion: boolean;
  sampleMs: number;
};

export const INTRO_FLIGHT_KEYFRAME_STEPS = 24;
export const INTRO_FLIGHT_PERF_SAMPLE_MS = 250;
export const INTRO_FLIGHT_PERF_MIN_FPS = 30;

export function parseDebugNewStancesMotionParams(search: string): DebugNewStancesMotionParams {
  const params = new URLSearchParams(search);
  return {
    enabled: params.get("debugNewStances") === "1" && params.get("debugNewStancesMotion") === "1",
  };
}

export function flightDurationMs(reducedMotion: boolean): number {
  return reducedMotion ? INTRO_TIMING.reducedCrossfadeMs : INTRO_FLIGHT_DURATION_MS;
}

export function flightStaggerMs(reducedMotion: boolean, itemIndex: number): number {
  return reducedMotion ? 0 : itemIndex * INTRO_FLIGHT_STAGGER_MS;
}

/** Samples eased motion along the approved bezier path for WAAPI keyframes. */
export function sampleFlightTransformAt(
  item: IntroItem,
  view: StagingView,
  reducedMotion: boolean,
  tRaw: number
): { transform: string; baseSidePx: number } {
  const keyframes = buildFlightKeyframes(item, view, reducedMotion, INTRO_FLIGHT_KEYFRAME_STEPS);
  const idx = Math.max(0, Math.min(keyframes.length - 1, Math.round(tRaw * (keyframes.length - 1))));
  const baseSidePx = item.stagingSidePx || Math.max(8, item.finalSide * view.scale);
  return { transform: keyframes[idx]!.transform, baseSidePx };
}

export class IntroFlightMotionProfiler {
  private frameDeltas: number[] = [];
  private longFrameCount = 0;
  private lastTs = 0;
  readonly startedAt: number;

  constructor(startedAt = performance.now()) {
    this.startedAt = startedAt;
  }

  tick(now = performance.now()): void {
    if (this.lastTs > 0) {
      const delta = now - this.lastTs;
      this.frameDeltas.push(delta);
      if (delta > 32) this.longFrameCount += 1;
    }
    this.lastTs = now;
  }

  getSampledFps(sampleMs = INTRO_FLIGHT_PERF_SAMPLE_MS): number {
    if (!this.frameDeltas.length) return 0;
    let total = 0;
    let count = 0;
    for (const delta of this.frameDeltas) {
      total += delta;
      count += 1;
      if (total >= sampleMs) break;
    }
    if (total <= 0 || count === 0) return 0;
    return Math.round((count / total) * 1000);
  }

  shouldSimplifyEffects(sampleMs = INTRO_FLIGHT_PERF_SAMPLE_MS): boolean {
    const fps = this.getSampledFps(sampleMs);
    if (fps <= 0) return false;
    return fps < INTRO_FLIGHT_PERF_MIN_FPS;
  }

  buildReport(opts: {
    flightDurationMs: number;
    flyingAvatarCount: number;
    simplifiedEffects: boolean;
    reducedMotion: boolean;
    sampleMs?: number;
  }): IntroFlightMotionReport {
    const sampleMs = opts.sampleMs ?? INTRO_FLIGHT_PERF_SAMPLE_MS;
    return {
      measuredFps: this.getSampledFps(sampleMs),
      longFramesAbove32Ms: this.longFrameCount,
      flightDurationMs: opts.flightDurationMs,
      flyingAvatarCount: opts.flyingAvatarCount,
      simplifiedEffects: opts.simplifiedEffects,
      reducedMotion: opts.reducedMotion,
      sampleMs,
    };
  }
}

export type WaapiFlightHandle = {
  element: HTMLElement;
  animation: Animation;
  fallbackTimer: ReturnType<typeof setTimeout>;
  itemId: string;
};

export function startWaapiFlightAnimation(opts: {
  element: HTMLElement;
  item: IntroItem;
  view: StagingView;
  reducedMotion: boolean;
  itemIndex: number;
  onFinished: (itemId: string) => void;
}): WaapiFlightHandle {
  const { element, item, view, reducedMotion, itemIndex, onFinished } = opts;
  const duration = flightDurationMs(reducedMotion);
  const delay = flightStaggerMs(reducedMotion, itemIndex);
  const keyframes = buildFlightKeyframes(item, view, reducedMotion, INTRO_FLIGHT_KEYFRAME_STEPS);
  const animation = element.animate(keyframes, {
    duration,
    delay,
    easing: "linear",
    fill: "forwards",
  });
  element.style.willChange = "transform";

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    element.style.willChange = "";
    element.remove();
    onFinished(item.xUserId);
  };

  animation.addEventListener("finish", finish, { once: true });
  animation.addEventListener("cancel", finish, { once: true });

  const fallbackTimer = setTimeout(finish, duration + delay + 120);

  return {
    element,
    animation,
    fallbackTimer,
    itemId: item.xUserId,
  };
}

export function cancelWaapiFlight(handles: WaapiFlightHandle[]): void {
  for (const handle of handles) {
    clearTimeout(handle.fallbackTimer);
    try {
      handle.animation.cancel();
    } catch {
      // ignore
    }
    handle.element.remove();
  }
}

/** Easing baked into keyframe offsets — linear timing between samples. */
export function flightKeyframeEasing(): string {
  return "linear";
}

/** Confirms reduced-motion media query without overriding it. */
export function readReducedMotionPreference(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export { easeIntroFlight };
