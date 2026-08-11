import React, { useMemo } from "react";
import { selectDistantProposals } from "../config/proposals";

function hashSeed(text) {
  return [...String(text)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
}

/** Deterministic placement: flanks center mass, varies scale/rotation, avoids rigid stack. */
function distantLayout(proposalId, index) {
  const seed = hashSeed(proposalId) + index * 17;
  const sideIndex = index % 2;
  const row = Math.floor(index / 2);
  const xJitter = ((seed % 11) - 5) * 0.35;
  const yJitter = ((seed % 7) - 3) * 0.55;
  const depth = 0.78 + ((seed % 5) / 5) * 0.2; // farther → smaller (~15–25%)
  return {
    x: (sideIndex === 0 ? 8.5 : 91.5) + xJitter,
    y: 16 + row * 11 + yJitter,
    scale: depth,
    rotate: ((seed % 13) - 6) * 1.4,
  };
}

function galaxyStars(proposalId, count = 28) {
  const seed = hashSeed(proposalId);
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
 * Exploratory distant galaxies — interactive shortcuts into travelToGalaxy.
 * Capped subset of inactive proposals; full catalog remains in the header dropdown.
 */
export function DistantGalaxies({
  activeProposalId,
  catalog,
  reducedMotion = false,
  disabled = false,
  onNavigate,
}) {
  const others = useMemo(
    () => selectDistantProposals(activeProposalId, catalog, 4),
    [activeProposalId, catalog]
  );

  return (
    <div className="distantGalaxies" aria-label="Nearby consensus galaxies">
      {others.map((p, i) => {
        const pos = distantLayout(p.id, i);
        const theme = p.visualTheme;
        const stars = galaxyStars(p.id);
        const label = `Travel to ${p.title}: ${p.description}`;
        return (
          <button
            key={p.id}
            type="button"
            className={`distantGalaxy${reducedMotion ? " distantGalaxy--static" : ""}`}
            disabled={disabled}
            aria-label={label}
            title={label}
            onClick={() => {
              if (disabled) return;
              onNavigate?.(p.id);
            }}
            style={{
              left: `${pos.x}%`,
              top: `${pos.y}%`,
              "--galaxy-accent": theme.accent,
              "--galaxy-glow": theme.distantGlow,
              "--galaxy-scale": String(pos.scale),
              "--galaxy-rotate": `${pos.rotate}deg`,
            }}
          >
            <span className="distantGalaxy__label">
              <strong>{p.title}</strong>
            </span>
            <span className="distantGalaxy__core" aria-hidden="true">
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
          </button>
        );
      })}
    </div>
  );
}
