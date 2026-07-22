/** Opt-in performance diagnostics via `?debugPerformance=1`. Silent in normal production. */

export type PerfDebugCounters = {
  avatarRequests: number;
  avatarCacheHits: number;
  avatarNetworkLoads: number;
  avatarDecodeOk: number;
  avatarDecodeFail: number;
  drawCalls: number;
  fullDrawCalls: number;
  fastPanDrawCalls: number;
  dragFrames: number;
  dragFrameMsTotal: number;
  dragFrameMsMax: number;
  worldLayerBuilds: number;
  lastApiMs: number | null;
  firstBackgroundPaintMs: number | null;
  firstAvatarPaintMs: number | null;
  allVisibleAvatarsPaintedMs: number | null;
};

const emptyCounters = (): PerfDebugCounters => ({
  avatarRequests: 0,
  avatarCacheHits: 0,
  avatarNetworkLoads: 0,
  avatarDecodeOk: 0,
  avatarDecodeFail: 0,
  drawCalls: 0,
  fullDrawCalls: 0,
  fastPanDrawCalls: 0,
  dragFrames: 0,
  dragFrameMsTotal: 0,
  dragFrameMsMax: 0,
  worldLayerBuilds: 0,
  lastApiMs: null,
  firstBackgroundPaintMs: null,
  firstAvatarPaintMs: null,
  allVisibleAvatarsPaintedMs: null,
});

let enabled = false;
let navStart = 0;
let counters = emptyCounters();
let overlayEl: HTMLDivElement | null = null;

export function parseDebugPerformance(search: string): boolean {
  try {
    const v = new URLSearchParams(search).get("debugPerformance");
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

export function initPerfDebug(search: string): boolean {
  enabled = parseDebugPerformance(search);
  if (!enabled) return false;
  counters = emptyCounters();
  navStart =
    typeof performance !== "undefined" && performance.timeOrigin
      ? performance.now()
      : 0;
  return true;
}

export function isPerfDebugEnabled(): boolean {
  return enabled;
}

export function perfMark(name: string): void {
  if (!enabled || typeof performance === "undefined") return;
  try {
    performance.mark(`ch:${name}`);
  } catch {
    /* ignore */
  }
}

export function perfNowSinceNav(): number {
  if (typeof performance === "undefined") return 0;
  return performance.now() - (navStart || 0);
}

export function perfCounters(): PerfDebugCounters {
  return counters;
}

export function perfInc<K extends keyof PerfDebugCounters>(key: K, by = 1): void {
  if (!enabled) return;
  const cur = counters[key];
  if (typeof cur === "number") {
    (counters as Record<string, number | null>)[key] = (cur as number) + by;
  }
}

export function perfSetMs(
  key:
    | "lastApiMs"
    | "firstBackgroundPaintMs"
    | "firstAvatarPaintMs"
    | "allVisibleAvatarsPaintedMs",
  ms: number
): void {
  if (!enabled) return;
  if (counters[key] == null) counters[key] = ms;
  else if (key === "lastApiMs") counters[key] = ms;
}

export function perfRecordDragFrame(ms: number): void {
  if (!enabled) return;
  counters.dragFrames += 1;
  counters.dragFrameMsTotal += ms;
  if (ms > counters.dragFrameMsMax) counters.dragFrameMsMax = ms;
}

export function perfDragFps(): number | null {
  if (!enabled || counters.dragFrames < 2) return null;
  const avg = counters.dragFrameMsTotal / counters.dragFrames;
  return avg > 0 ? Math.round(1000 / avg) : null;
}

export function ensurePerfOverlay(): void {
  if (!enabled || typeof document === "undefined") return;
  if (overlayEl && document.body.contains(overlayEl)) return;
  overlayEl = document.createElement("div");
  overlayEl.setAttribute("data-perf-debug", "1");
  Object.assign(overlayEl.style, {
    position: "fixed",
    left: "8px",
    bottom: "8px",
    zIndex: "99999",
    maxWidth: "min(420px, 92vw)",
    padding: "8px 10px",
    borderRadius: "8px",
    background: "rgba(0,0,0,0.72)",
    color: "#d7ffe0",
    font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
  });
  document.body.appendChild(overlayEl);
}

export function updatePerfOverlay(extraLines: string[] = []): void {
  if (!enabled) return;
  ensurePerfOverlay();
  if (!overlayEl) return;
  const c = counters;
  const avgDrag =
    c.dragFrames > 0 ? (c.dragFrameMsTotal / c.dragFrames).toFixed(1) : "—";
  const fps = perfDragFps();
  const lines = [
    "debugPerformance=1",
    `api=${c.lastApiMs ?? "—"}ms bg=${c.firstBackgroundPaintMs ?? "—"}ms`,
    `firstAvatar=${c.firstAvatarPaintMs ?? "—"}ms allVisible=${c.allVisibleAvatarsPaintedMs ?? "—"}ms`,
    `img req=${c.avatarRequests} hit=${c.avatarCacheHits} net=${c.avatarNetworkLoads} decOk=${c.avatarDecodeOk} fail=${c.avatarDecodeFail}`,
    `draw full=${c.fullDrawCalls} panFast=${c.fastPanDrawCalls} worldBuilds=${c.worldLayerBuilds}`,
    `drag frames=${c.dragFrames} avg=${avgDrag}ms max=${c.dragFrameMsMax.toFixed(1)}ms fps≈${fps ?? "—"}`,
    ...extraLines,
  ];
  overlayEl.textContent = lines.join("\n");
}
