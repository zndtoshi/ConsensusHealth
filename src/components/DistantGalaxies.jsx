import React, { useMemo, useState } from "react";
import { listEnabledProposals } from "../config/proposals";

/** Deterministic distant positions so galaxies don't jump on rerender. */
function distantLayout(id, index) {
  const seeds = {
    bip110: { x: 12, y: 28 },
    bip54: { x: 86, y: 22 },
    bip119: { x: 78, y: 72 },
  };
  return seeds[id] || { x: 20 + index * 30, y: 30 + index * 18 };
}

/**
 * Decorative clickable distant galaxies for inactive proposals (admin only).
 * Not full graphs — lightweight markers only.
 */
export function DistantGalaxies({
  activeProposalId,
  disabled = false,
  onNavigate,
  reducedMotion = false,
}) {
  const others = useMemo(
    () => listEnabledProposals().filter((p) => p.id !== activeProposalId),
    [activeProposalId]
  );
  const [tipId, setTipId] = useState(null);

  return (
    <div className="distantGalaxies" aria-hidden={false}>
      {others.map((p, i) => {
        const pos = distantLayout(p.id, i);
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
            <span className="distantGalaxy__core" />
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
