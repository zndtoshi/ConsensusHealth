import React, { useMemo } from "react";
import { listEnabledProposals } from "../config/proposals";

/** Keep inactive galaxies flanking the center mass on one horizontal band. */
function distantLayout(index) {
  const sideIndex = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: sideIndex === 0 ? 9 : 91,
    y: 17 + row * 9,
  };
}

function galaxyStars(proposalId, count = 30) {
  const seed = [...String(proposalId)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  return Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963 + seed * 0.017;
    const radius = 7 + Math.sqrt((index + 1) / count) * 39;
    const ripple = 0.72 + ((index * 17 + seed) % 29) / 100;
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius * 0.43 * ripple,
      size: 1 + ((index * 7 + seed) % 4) * 0.55,
      alpha: 0.38 + ((index * 11 + seed) % 50) / 100,
    };
  });
}

/**
 * Decorative distant galaxies for inactive proposals (admin only).
 * Visual markers only — not navigation controls.
 */
export function DistantGalaxies({
  activeProposalId,
  catalog,
  reducedMotion = false,
}) {
  const others = useMemo(
    () => listEnabledProposals(catalog).filter((p) => p.id !== activeProposalId),
    [activeProposalId, catalog]
  );

  return (
    <div className="distantGalaxies" aria-hidden="true">
      {others.map((p, i) => {
        const pos = distantLayout(i);
        const theme = p.visualTheme;
        const stars = galaxyStars(p.id);
        return (
          <div
            key={p.id}
            className={`distantGalaxy distantGalaxy--decorative${
              reducedMotion ? " distantGalaxy--static" : ""
            }`}
            style={{
              left: `${pos.x}%`,
              top: `${pos.y}%`,
              "--galaxy-accent": theme.accent,
              "--galaxy-glow": theme.distantGlow,
            }}
          >
            <span className="distantGalaxy__label">
              <strong>{p.title}</strong>
            </span>
            <span className="distantGalaxy__core">
              <span className="distantGalaxy__dust" />
              <span className="distantGalaxy__arms" />
              {stars.map((star, starIndex) => (
                <span
                  key={starIndex}
                  className="distantGalaxy__star"
                  style={{
                    left: `${star.x}%`,
                    top: `${star.y}%`,
                    width: `${star.size}px`,
                    height: `${star.size}px`,
                    opacity: star.alpha,
                  }}
                />
              ))}
              <span className="distantGalaxy__bulge" />
            </span>
          </div>
        );
      })}
    </div>
  );
}
