import React from "react";

/**
 * Subtle solitary discovery star — only mounted in full BIP galaxy views.
 * Native button handles Enter/Space; do not add a manual keydown activator.
 */
export function HiddenGalaxyStar({
  reducedMotion = false,
  disabled = false,
  onDiscover,
}) {
  return (
    <button
      type="button"
      className={`hiddenGalaxyStar${reducedMotion ? " is-static" : ""}`}
      disabled={disabled}
      aria-label="Discover a hidden galaxy"
      title="A distant signal..."
      onClick={() => {
        if (disabled) return;
        onDiscover?.();
      }}
    >
      <span className="hiddenGalaxyStar__glyph" aria-hidden="true">
        <span className="hiddenGalaxyStar__ray hiddenGalaxyStar__ray--n" />
        <span className="hiddenGalaxyStar__ray hiddenGalaxyStar__ray--e" />
        <span className="hiddenGalaxyStar__ray hiddenGalaxyStar__ray--s" />
        <span className="hiddenGalaxyStar__ray hiddenGalaxyStar__ray--w" />
        <span className="hiddenGalaxyStar__core" />
      </span>
    </button>
  );
}
