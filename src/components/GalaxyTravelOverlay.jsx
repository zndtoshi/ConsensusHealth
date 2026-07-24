import React from "react";
import { getProposalById } from "../config/proposals";

/**
 * Full-viewport travel veil during galaxy transitions.
 * Visual only — data swap is driven by parent at midpoint.
 */
export function GalaxyTravelOverlay({
  active,
  fromId,
  toId,
  progress = 0,
  reducedMotion = false,
}) {
  if (!active) return null;
  const from = getProposalById(fromId);
  const to = getProposalById(toId);
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
          to?.visualTheme.nebulaFrom || "rgba(30,41,59,0.4)"
        } 0%, ${from?.visualTheme.nebulaTo || "rgba(2,6,23,0.85)"} 70%)`,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    />
  );
}
