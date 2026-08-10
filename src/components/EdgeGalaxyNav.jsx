import React from "react";
import { getAdjacent } from "../utils/proposalNavigation";

export function EdgeGalaxyNav({
  proposalId,
  catalog,
  disabled = false,
  onNavigate,
}) {
  const { prev, next } = getAdjacent(proposalId, catalog);
  return (
    <>
      <button
        type="button"
        className="edgeGalaxyNav edgeGalaxyNav--left"
        disabled={disabled}
        onClick={() => onNavigate(prev.id)}
        aria-label={`Travel to previous galaxy ${prev.shortName}`}
        title={prev.shortName}
      >
        <span className="edgeGalaxyNav__label">{prev.shortName}</span>
      </button>
      <button
        type="button"
        className="edgeGalaxyNav edgeGalaxyNav--right"
        disabled={disabled}
        onClick={() => onNavigate(next.id)}
        aria-label={`Travel to next galaxy ${next.shortName}`}
        title={next.shortName}
      >
        <span className="edgeGalaxyNav__label">{next.shortName}</span>
      </button>
    </>
  );
}
