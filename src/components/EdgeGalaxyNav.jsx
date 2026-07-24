import React from "react";
import { getAdjacent } from "../utils/proposalNavigation";

/** Subtle left/right edge hit targets for galaxy travel (admin). */
export function EdgeGalaxyNav({
  proposalId,
  disabled = false,
  onNavigate,
}) {
  const { prev, next } = getAdjacent(proposalId);
  return (
    <>
      <button
        type="button"
        className="edgeGalaxyNav edgeGalaxyNav--left"
        disabled={disabled}
        onClick={() => onNavigate(prev.id)}
        aria-label={`Go to ${prev.shortName}`}
      >
        <span className="edgeGalaxyNav__label">{prev.shortName}</span>
      </button>
      <button
        type="button"
        className="edgeGalaxyNav edgeGalaxyNav--right"
        disabled={disabled}
        onClick={() => onNavigate(next.id)}
        aria-label={`Go to ${next.shortName}`}
      >
        <span className="edgeGalaxyNav__label">{next.shortName}</span>
      </button>
    </>
  );
}
