/**
 * Schedule focus restoration after a covering overlay unmounts and any
 * inert ancestor becomes interactive again.
 *
 * Focusing inside an inert subtree silently fails, so callers must invoke this
 * only after React has committed with inert cleared (typically double-rAF).
 */
export function scheduleFocusRestore(
  target: { focus?: (() => void) | null } | null | undefined,
  schedule: (run: () => void) => void = (run) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(run));
      return;
    }
    setTimeout(run, 0);
  }
): void {
  if (!target || typeof target.focus !== "function") return;
  const el = target;
  schedule(() => {
    try {
      el.focus?.();
    } catch {
      /* ignore detached / inert race leftovers */
    }
  });
}
