/**
 * Compact dual-handle year range for the Options "X join date" control.
 * Drag updates UI via onChange; membership commits only on release / keyboard debounce.
 */

import React, { useEffect, useRef } from "react";
import { JOIN_DATE_KEYBOARD_COMMIT_MS } from "../utils/filterAvatarTransitions";

export function XJoinDateRangeSlider({
  boundMin,
  boundMax,
  minYear,
  maxYear,
  onChange,
  onCommit,
  showingCount,
  totalCount,
}) {
  const span = Math.max(1, boundMax - boundMin);
  const draggingRef = useRef(false);
  const commitTimerRef = useRef(0);
  const latestRef = useRef({ minYear, maxYear });

  useEffect(() => {
    latestRef.current = { minYear, maxYear };
  }, [minYear, maxYear]);

  function clearCommitTimer() {
    if (commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = 0;
    }
  }

  function commitNow() {
    clearCommitTimer();
    const payload = {
      minYear: latestRef.current.minYear,
      maxYear: latestRef.current.maxYear,
    };
    if (typeof onCommit === "function") onCommit(payload);
    else onChange(payload);
  }

  function scheduleKeyboardCommit() {
    clearCommitTimer();
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = 0;
      if (!draggingRef.current) commitNow();
    }, JOIN_DATE_KEYBOARD_COMMIT_MS);
  }

  useEffect(() => () => clearCommitTimer(), []);

  function setMin(next) {
    const n = Math.trunc(Number(next));
    if (!Number.isFinite(n)) return;
    const payload = { minYear: Math.min(n, maxYear), maxYear };
    latestRef.current = payload;
    onChange(payload);
    if (!draggingRef.current) scheduleKeyboardCommit();
  }

  function setMax(next) {
    const n = Math.trunc(Number(next));
    if (!Number.isFinite(n)) return;
    const payload = { minYear, maxYear: Math.max(n, minYear) };
    latestRef.current = payload;
    onChange(payload);
    if (!draggingRef.current) scheduleKeyboardCommit();
  }

  function beginDrag() {
    draggingRef.current = true;
    clearCommitTimer();
  }

  function endDrag() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    commitNow();
  }

  const minPct = ((minYear - boundMin) / span) * 100;
  const maxPct = ((maxYear - boundMin) / span) * 100;

  const releaseHandlers = {
    onPointerUp: endDrag,
    onMouseUp: endDrag,
    onTouchEnd: endDrag,
    onPointerCancel: endDrag,
  };

  return (
    <div className="xJoinDateFilter" role="group" aria-label="X join date year range">
      <div className="xJoinDateFilter__years" aria-hidden="true">
        <span>{minYear}</span>
        <span>{maxYear}</span>
      </div>
      <div className="xJoinDateFilter__trackWrap">
        <div className="xJoinDateFilter__rail" aria-hidden="true" />
        <div
          className="xJoinDateFilter__fill"
          aria-hidden="true"
          style={{ left: `${minPct}%`, width: `${Math.max(0, maxPct - minPct)}%` }}
        />
        <input
          type="range"
          className="xJoinDateFilter__input xJoinDateFilter__input--min"
          min={boundMin}
          max={boundMax}
          step={1}
          value={minYear}
          onChange={(e) => setMin(e.target.value)}
          onPointerDown={beginDrag}
          onMouseDown={beginDrag}
          onTouchStart={beginDrag}
          {...releaseHandlers}
          aria-label="Minimum X join year"
          aria-valuemin={boundMin}
          aria-valuemax={boundMax}
          aria-valuenow={minYear}
        />
        <input
          type="range"
          className="xJoinDateFilter__input xJoinDateFilter__input--max"
          min={boundMin}
          max={boundMax}
          step={1}
          value={maxYear}
          onChange={(e) => setMax(e.target.value)}
          onPointerDown={beginDrag}
          onMouseDown={beginDrag}
          onTouchStart={beginDrag}
          {...releaseHandlers}
          aria-label="Maximum X join year"
          aria-valuemin={boundMin}
          aria-valuemax={boundMax}
          aria-valuenow={maxYear}
        />
      </div>
      <div className="xJoinDateFilter__bounds" aria-hidden="true">
        <span>{boundMin}</span>
        <span>{boundMax}</span>
      </div>
      {typeof showingCount === "number" && typeof totalCount === "number" ? (
        <div className="xJoinDateFilter__meta">
          <span>
            Showing {showingCount} of {totalCount} accounts
          </span>
        </div>
      ) : null}
    </div>
  );
}
