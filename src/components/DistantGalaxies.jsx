import React, { useMemo, useState } from "react";
import { listEnabledProposals } from "../config/proposals";

/** Keep inactive galaxies flanking the center mass on one horizontal band. */
function distantLayout(index) {
  const sideIndex = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: sideIndex === 0 ? 14 : 86,
    y: Math.max(30, 45 - row * 8),
  };
}

/**
 * Decorative clickable distant galaxies for inactive proposals (admin only).
 * Lightweight markers only — not full graphs.
 */
export function DistantGalaxies({
  activeProposalId,
  catalog,
  disabled = false,
  onNavigate,
  reducedMotion = false,
}) {
  const others = useMemo(
    () => listEnabledProposals(catalog).filter((p) => p.id !== activeProposalId),
    [activeProposalId, catalog]
  );
  const [tipId, setTipId] = useState(null);

  return (
    <div className="distantGalaxies" aria-hidden={false}>
      {others.map((p, i) => {
        const pos = distantLayout(i);
        const theme = p.visualTheme;
        const showTip = tipId === p.id;
        return (
          <button
            key={p.id}
            type="button"
            className={`distantGalaxy${reducedMotion ? " distantGalaxy--static" : ""}`}
            style={{
              left: `${pos.x}%`,
              top: `${pos.y}%`,
              "--galaxy-accent": theme.accent,
              "--galaxy-glow": theme.distantGlow,
            }}
            disabled={disabled}
            onClick={() => onNavigate(p.id)}
            onMouseEnter={() => setTipId(p.id)}
            onMouseLeave={() => setTipId(null)}
            onFocus={() => setTipId(p.id)}
            onBlur={() => setTipId(null)}
            aria-label={`${p.shortName}: ${p.description}`}
            title={p.shortName}
          >
            <span className="distantGalaxy__label" aria-hidden="true">
              <strong>{p.title}</strong>
              <span>consensus galaxy</span>
            </span>
            <span className="distantGalaxy__core" aria-hidden="true">
              <span className="distantGalaxy__arms" />
              <span className="distantGalaxy__bulge" />
            </span>
            {showTip ? (
              <span className="distantGalaxy__tip" role="tooltip">
                <strong>{p.shortName}</strong>
                <span>{p.description}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
