import React from "react";
import { getProposalById } from "../config/proposals";
import { getAdjacent } from "../utils/proposalNavigation";

/**
 * Admin galaxy header: [prev] [ACTIVE] [next] — replaces centered selected-user title.
 */
export function GalaxyHeaderNav({
  proposalId,
  disabled = false,
  onNavigate,
}) {
  const { prev, next, current } = getAdjacent(proposalId);
  const theme = getProposalById(current.id)?.visualTheme;

  return (
    <nav className="galaxyHeaderNav" aria-label="Consensus galaxies">
      <button
        type="button"
        className="galaxyHeaderNav__side"
        disabled={disabled}
        onClick={() => onNavigate(prev.id)}
        title={`Travel to ${prev.shortName}`}
        aria-label={`Previous galaxy ${prev.shortName}`}
      >
        {prev.shortName}
      </button>
      <div
        className="galaxyHeaderNav__current"
        style={{
          color: theme?.accent,
          textShadow: theme ? `0 0 18px ${theme.accentSoft}` : undefined,
        }}
        aria-current="page"
      >
        {current.shortName}
      </div>
      <button
        type="button"
        className="galaxyHeaderNav__side"
        disabled={disabled}
        onClick={() => onNavigate(next.id)}
        title={`Travel to ${next.shortName}`}
        aria-label={`Next galaxy ${next.shortName}`}
      >
        {next.shortName}
      </button>
    </nav>
  );
}
