import React from "react";
import { GalaxyHeaderNav } from "../../components/GalaxyHeaderNav";
import { DistantGalaxies } from "../../components/DistantGalaxies";
import { EdgeGalaxyNav } from "../../components/EdgeGalaxyNav";
import { GalaxyTravelOverlay } from "../../components/GalaxyTravelOverlay";

/** Lazy-loaded admin-only galaxy chrome (header + overlays). */
export default function ConsensusUniverseChrome({
  slot,
  proposalId,
  catalog,
  disabled,
  onNavigate,
  reducedMotion,
  parallaxRef,
  travel,
  fromProposal,
  toProposal,
}) {
  if (slot === "header") {
    return (
      <GalaxyHeaderNav
        proposalId={proposalId}
        catalog={catalog}
        disabled={disabled}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <>
      <div ref={parallaxRef} className="galaxyParallaxLayer" aria-hidden="true" />
      <DistantGalaxies
        activeProposalId={proposalId}
        catalog={catalog}
        disabled={disabled}
        onNavigate={onNavigate}
        reducedMotion={reducedMotion}
      />
      <EdgeGalaxyNav
        proposalId={proposalId}
        catalog={catalog}
        disabled={disabled}
        onNavigate={onNavigate}
      />
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
