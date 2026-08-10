import React from "react";
import { getAdjacent } from "../utils/proposalNavigation";
import { DEFAULT_PROPOSAL_ID, proposalGithubUrl } from "../config/proposals";

/**
 * Admin galaxy header: [prev] [ACTIVE] [next]
 */
export function GalaxyHeaderNav({
  proposalId,
  catalog,
  disabled = false,
  onNavigate,
  showNavigation = true,
}) {
  const { prev, next, current } = getAdjacent(proposalId, catalog);
  const theme = current?.visualTheme;
  const proposalUrl = proposalGithubUrl(current?.id);
  const isFinalSnapshot = current?.id === DEFAULT_PROPOSAL_ID;

  return (
    <nav
      className={`galaxyHeaderNav${showNavigation ? "" : " galaxyHeaderNav--single"}`}
      aria-label="Consensus proposals"
    >
      {showNavigation ? (
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
      ) : null}
      <div className="galaxyHeaderNav__identity" aria-current="page" tabIndex={0}>
        <div className="galaxyHeaderNav__titleRow">
          {isFinalSnapshot ? (
            <svg className="galaxyHeaderNav__lock" viewBox="0 0 16 16" aria-label="Final locked snapshot">
              <path fill="currentColor" d="M4.75 6V4.75a3.25 3.25 0 0 1 6.5 0V6h.5A1.25 1.25 0 0 1 13 7.25v6.5A1.25 1.25 0 0 1 11.75 15h-7.5A1.25 1.25 0 0 1 3 13.75v-6.5A1.25 1.25 0 0 1 4.25 6h.5Zm1.5 0h3.5V4.75a1.75 1.75 0 0 0-3.5 0V6Z" />
            </svg>
          ) : null}
          <div
            className="galaxyHeaderNav__current"
            style={{
              color: theme?.accent,
              textShadow: theme ? `0 0 18px ${theme.accentSoft}` : undefined,
            }}
          >
            {current.title}
          </div>
          {proposalUrl ? (
            <a
              className="galaxyHeaderNav__github"
              href={proposalUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open the official ${current.shortName} proposal on GitHub`}
              aria-label={`Open the official ${current.shortName} proposal on GitHub`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path fill="currentColor" d="M12 .7a11.3 11.3 0 0 0-3.57 22.02c.56.1.77-.24.77-.54v-2.12c-3.12.68-3.78-1.33-3.78-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.4-1.22.71-1.5-2.49-.28-5.1-1.25-5.1-5.58 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.11 1.16A10.8 10.8 0 0 1 12 6.18c.96 0 1.92.13 2.82.38 2.16-1.46 3.1-1.16 3.1-1.16.62 1.55.23 2.7.12 2.98.72.79 1.16 1.8 1.16 3.03 0 4.34-2.62 5.29-5.12 5.57.4.35.76 1.03.76 2.08v3.12c0 .3.2.65.77.54A11.3 11.3 0 0 0 12 .7Z" />
              </svg>
            </a>
          ) : null}
        </div>
        <div className="galaxyHeaderNav__description">{current.description}</div>
        <div className="galaxyHeaderNav__tooltip" role="tooltip">
          <strong>{current.title}</strong>
          <span>{current.description}</span>
          <span className="galaxyHeaderNav__status">
            {isFinalSnapshot
              ? "Concluded without consensus. Positions are locked and preserved as a final snapshot."
              : "Admin preview galaxy. Positions are currently managed by @zndtoshi."}
          </span>
        </div>
      </div>
      {showNavigation ? (
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
      ) : null}
    </nav>
  );
}
