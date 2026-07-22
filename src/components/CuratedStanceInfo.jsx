import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const TOOLTIP_TITLE = "About curated stances";
const TOOLTIP_BODY =
  "The initial seed of approximately 150 accounts was curated using AI-assisted analysis and manual review of public statements.\n\nNick Szabo has not publicly endorsed BIP110. His initial placement in the Against cluster reflects his publicly known opposition to Bitcoin Core v30 and is an editorial judgment, not a direct statement about BIP110.";

/**
 * Subtle (i) icon + floating tooltip for the footer curated-stances note.
 */
export function CuratedStanceInfo() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const tipRef = useRef(null);
  const closeTimerRef = useRef(0);
  const tipId = useId();
  const hoverCapableRef = useRef(false);

  useEffect(() => {
    hoverCapableRef.current =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }, []);

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = 0;
    }
  }

  function openTip() {
    clearCloseTimer();
    setOpen(true);
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const tip = tipRef.current;
    const anchor = rootRef.current;
    if (!tip || !anchor) return;

    const pad = 10;
    // Measure after open class applies.
    const rect = tip.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    let left = anchorRect.left + anchorRect.width / 2 - rect.width / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - rect.width - pad));

    let top = anchorRect.top - rect.height - 10;
    if (top < pad) {
      top = Math.min(window.innerHeight - rect.height - pad, anchorRect.bottom + 10);
    }

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(e) {
      const root = rootRef.current;
      const tip = tipRef.current;
      if (root?.contains(e.target) || tip?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    []
  );

  return (
    <span ref={rootRef} className="curatedInfo">
      <button
        type="button"
        className="curatedInfo__btn"
        aria-label="About curated stances"
        aria-expanded={open}
        aria-controls={tipId}
        onMouseEnter={() => {
          if (hoverCapableRef.current) openTip();
        }}
        onMouseLeave={() => {
          if (hoverCapableRef.current) scheduleClose();
        }}
        onFocus={() => openTip()}
        onBlur={(e) => {
          if (!rootRef.current?.contains(e.relatedTarget) && !tipRef.current?.contains(e.relatedTarget)) {
            setOpen(false);
          }
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!hoverCapableRef.current) setOpen((v) => !v);
        }}
      >
        <span className="curatedInfo__glyph" aria-hidden="true">
          i
        </span>
      </button>
      <div
        ref={tipRef}
        id={tipId}
        role="tooltip"
        className={`curatedInfo__tip${open ? " is-open" : ""}`}
        onMouseEnter={() => {
          if (hoverCapableRef.current) openTip();
        }}
        onMouseLeave={() => {
          if (hoverCapableRef.current) scheduleClose();
        }}
      >
        <div className="curatedInfo__tipTitle">{TOOLTIP_TITLE}</div>
        <div className="curatedInfo__tipBody">
          {TOOLTIP_BODY.split("\n\n").map((para) => (
            <p key={para.slice(0, 32)}>{para}</p>
          ))}
        </div>
      </div>
    </span>
  );
}
