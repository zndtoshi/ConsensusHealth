import React, { useMemo } from "react";
import { DISTANT_GALAXIES_VISIBLE_LIMIT, selectDistantProposals } from "../config/proposals";
import { distantLayout } from "../utils/distantGalaxyLayout";

function hashSeed(text) {
  return [...String(text)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
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
    () => selectDistantProposals(activeProposalId, catalog, DISTANT_GALAXIES_VISIBLE_LIMIT),
    [activeProposalId, catalog]
  );

  return (
    <div className="distantGalaxies" aria-label="Nearby consensus galaxies">
      {others.map((p) => {
        // Pose is ID-stable; active BIP is simply omitted so slots never jump.
        const pos = distantLayout(p.id);
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
