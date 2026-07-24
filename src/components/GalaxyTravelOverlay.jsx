import React from "react";

/**
 * Full-viewport travel veil during galaxy transitions.
 */
export function GalaxyTravelOverlay({
  active,
  fromProposal,
  toProposal,
  progress = 0,
  reducedMotion = false,
}) {
  if (!active) return null;
  const p = Math.max(0, Math.min(1, progress));
  const scale = reducedMotion ? 1 : 1 + p * 0.12;
  const opacity = reducedMotion ? Math.min(1, p * 2) : 0.25 + p * 0.45;

  return (
    <div
      className="galaxyTravelOverlay"
      style={{
        opacity,
        transform: `scale(${scale})`,
        background: `radial-gradient(ellipse at 50% 45%, ${
          toProposal?.visualTheme?.nebulaFrom || "rgba(30,41,59,0.4)"
        } 0%, ${fromProposal?.visualTheme?.nebulaTo || "rgba(2,6,23,0.85)"} 70%)`,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    />
  );
}
