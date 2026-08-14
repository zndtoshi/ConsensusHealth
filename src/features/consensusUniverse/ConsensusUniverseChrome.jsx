import React from "react";
import { GalaxyHeaderNav } from "../../components/GalaxyHeaderNav";
import { DistantGalaxies } from "../../components/DistantGalaxies";
import { GalaxyTravelOverlay } from "../../components/GalaxyTravelOverlay";

/** Lazy-loaded multi-galaxy chrome (header + overlays). */
export default function ConsensusUniverseChrome({
  slot,
  proposalId,
  catalog,
  disabled,
  onNavigate,
  onOverview,
  reducedMotion,
  parallaxRef,
  travel,
  fromProposal,
  toProposal,
  showDistantGalaxies = true,
}) {
  if (slot === "header") {
    return (
      <GalaxyHeaderNav
        proposalId={proposalId}
        catalog={catalog}
        disabled={disabled}
        onNavigate={onNavigate}
        onOverview={onOverview}
      />
    );
  }

  return (
    <>
      <div ref={parallaxRef} className="galaxyParallaxLayer" aria-hidden="true" />
      {showDistantGalaxies ? (
        <DistantGalaxies
          activeProposalId={proposalId}
          catalog={catalog}
          reducedMotion={reducedMotion}
          disabled={disabled}
          onNavigate={onNavigate}
        />
      ) : null}
      <GalaxyTravelOverlay
        active={Boolean(travel)}
        fromProposal={fromProposal}
        toProposal={toProposal}
        progress={travel?.progress || 0}
        reducedMotion={reducedMotion}
      />
    </>
  );
}
