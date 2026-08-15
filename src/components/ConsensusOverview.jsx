import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchConsensusOverview } from "../api/consensusOverview";
import { isFinalProposal, isOngoingProposal } from "../config/proposals";
import { STANCE_COLORS, STANCE_LABELS } from "../utils/stanceColors";
import {
  listOverviewCompletedProposals,
  listOverviewOngoingProposals,
  buildStanceStarKeys,
  mapOverviewPayloadToStats,
  overviewHeading,
  readMeProposalStance,
  resolveOverviewPersonalStance,
} from "../utils/consensusOverview";

function hashSeed(text) {
  return [...String(text)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
}

/** Tiny stance-weighted star field for a mini-galaxy preview. */
function stanceStars(stats, seedKey) {
  const against = Math.max(0, stats?.counts?.against || 0);
  const neutral = Math.max(0, stats?.counts?.neutral || 0);
  const approve = Math.max(0, stats?.counts?.approve || 0);
  const total = against + neutral + approve;
  const seed = hashSeed(seedKey);
  const count = 18;
  const stanceKeys = buildStanceStarKeys({ against, neutral, approve }, count);
  const colors = total <= 0
    ? Array(count).fill("rgba(226,232,240,0.35)")
    : stanceKeys.map((key) =>
        key === "neutral" ? "rgba(226,232,240,0.72)" : STANCE_COLORS[key]
      );
  return colors.map((color, index) => {
    const angle = index * 2.399963 + seed * 0.017;
    const radius = 10 + Math.sqrt((index + 1) / count) * 36;
    const ripple = 0.72 + ((index * 17 + seed) % 29) / 100;
    return {
      color,
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius * 0.48 * ripple,
      size: 1.2 + ((index * 7 + seed) % 4) * 0.45,
      alpha: 0.45 + ((index * 11 + seed) % 45) / 100,
    };
  });
}

function formatCount(n) {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.trunc(n || 0)));
}

function MiniGalaxyVisual({ proposal, stats, dimmed = false }) {
  const theme = proposal.visualTheme;
  const stars = useMemo(() => stanceStars(stats, proposal.id), [stats, proposal.id]);
  return (
    <span
      className={`consensusOverviewCard__galaxy${dimmed ? " is-dimmed" : ""}`}
      aria-hidden="true"
      style={{
        "--galaxy-accent": theme?.accent,
        "--galaxy-glow": theme?.distantGlow || theme?.accentSoft,
        "--galaxy-from": theme?.nebulaFrom,
      }}
    >
      <span className="consensusOverviewCard__dust" />
      <span className="consensusOverviewCard__arms" />
      {stars.map((star, i) => (
        <span
          key={i}
          className="consensusOverviewCard__star"
          style={{
            left: `${star.x}%`,
            top: `${star.y}%`,
            width: star.size,
            height: star.size,
            background: star.color,
            opacity: star.alpha,
          }}
        />
      ))}
    </span>
  );
}

function StanceBreakdown({ stats }) {
  const status = stats?.status || "loading";
  if (status === "loading") {
    return <div className="consensusOverviewCard__breakdown is-skeleton" aria-hidden="true" />;
  }
  if (status === "error") {
    return (
      <div className="consensusOverviewCard__breakdown is-error" role="status">
        Counts unavailable
      </div>
    );
  }
  const counts = stats?.counts || { against: 0, neutral: 0, approve: 0 };
  return (
    <ul className="consensusOverviewCard__breakdown">
      {["against", "neutral", "approve"].map((key) => (
        <li key={key}>
          <span
            className="consensusOverviewCard__stanceSwatch"
            style={{
              background: key === "neutral" ? "rgba(226,232,240,0.85)" : STANCE_COLORS[key],
            }}
            aria-hidden="true"
          />
          <span className="consensusOverviewCard__stanceLabel">{STANCE_LABELS[key]}</span>
          <span className="consensusOverviewCard__stanceCount">{formatCount(counts[key])}</span>
        </li>
      ))}
    </ul>
  );
}

function OverviewCard({
  proposal,
  stats,
  onEnter,
  reducedMotion = false,
  completed = false,
  authenticated = false,
  proposalStances = null,
}) {
  const theme = proposal.visualTheme;
  const total = stats?.totalUsersWithStance || 0;
  const statusLabel = completed
    ? "FINAL SNAPSHOT"
    : isOngoingProposal(proposal)
      ? "ONGOING"
      : isFinalProposal(proposal)
        ? "FINAL SNAPSHOT"
        : "";
  const name = completed ? `${proposal.shortName} — FINAL SNAPSHOT` : proposal.title;
  const personal = resolveOverviewPersonalStance({
    authenticated,
    completed,
    rawStance: readMeProposalStance(proposalStances, proposal.id),
  });
  const ariaName = [
    completed
      ? `Enter ${proposal.shortName} final snapshot galaxy`
      : `Enter ${proposal.shortName} galaxy`,
    personal.text,
  ]
    .filter(Boolean)
    .join(". ");

  const activate = useCallback(() => {
    onEnter(proposal.id);
  }, [onEnter, proposal.id]);

  return (
    <button
      type="button"
      className={`consensusOverviewCard${completed ? " consensusOverviewCard--completed" : ""}${
        reducedMotion ? " is-static" : ""
      }`}
      style={{
        "--card-accent": theme?.accent,
        "--card-glow": theme?.accentSoft,
      }}
      aria-label={ariaName}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
    >
      <MiniGalaxyVisual proposal={proposal} stats={stats} dimmed={completed} />
      <span className="consensusOverviewCard__body">
        <span className="consensusOverviewCard__titleRow">
          <strong className="consensusOverviewCard__title">{name}</strong>
          {statusLabel && !completed ? (
            <span className="consensusOverviewCard__status">{statusLabel}</span>
          ) : null}
        </span>
        {!completed ? <span className="consensusOverviewCard__desc">{proposal.description}</span> : null}
        <span className="consensusOverviewCard__participants">
          {stats?.status === "loading" ? (
            <span className="is-skeletonText">Loading participants…</span>
          ) : stats?.status === "error" ? (
            <span>Participants unavailable</span>
          ) : (
            <>
              <strong>{formatCount(total)}</strong>{" "}
              {total === 1 ? "account with a stance" : "accounts with a stance"}
            </>
          )}
        </span>
        {!completed ? <StanceBreakdown stats={stats} /> : null}
        {personal.text ? (
          <span
            className={`consensusOverviewCard__yourStance${
              personal.kind === "chosen" ? "" : " is-empty"
            }`}
          >
            Your stance:{" "}
            <span
              className="consensusOverviewCard__yourStanceValue"
              style={personal.valueColor ? { color: personal.valueColor } : undefined}
            >
              {personal.valueLabel}
            </span>
          </span>
        ) : null}
        <span className="consensusOverviewCard__cta">{completed ? "Open snapshot" : "Enter galaxy"}</span>
      </span>
    </button>
  );
}

export function ConsensusOverview({
  catalog,
  apiBase = "",
  reducedMotion = false,
  onEnterProposal,
  authenticated = false,
  proposalStances = null,
}) {
  const ongoing = useMemo(() => listOverviewOngoingProposals(catalog), [catalog]);
  const completed = useMemo(() => listOverviewCompletedProposals(catalog), [catalog]);
  const [payload, setPayload] = useState(null);
  const [loadState, setLoadState] = useState("loading");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const data = await fetchConsensusOverview({
          apiBase,
          signal: controller.signal,
        });
        if (cancelled) return;
        setPayload(data);
        setLoadState("ok");
      } catch {
        if (cancelled || controller.signal.aborted) return;
        setPayload(null);
        setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBase, reloadToken]);

  const retry = useCallback(() => {
    setPayload(null);
    setLoadState("loading");
    setReloadToken((n) => n + 1);
  }, []);

  const statsById = useMemo(() => {
    const map = new Map();
    for (const p of [...ongoing, ...completed]) {
      if (loadState === "loading") {
        map.set(p.id, {
          proposalId: p.id,
          totalUsersWithStance: 0,
          counts: { against: 0, neutral: 0, approve: 0 },
          status: "loading",
        });
      } else if (loadState === "error" || !payload) {
        map.set(p.id, {
          proposalId: p.id,
          totalUsersWithStance: 0,
          counts: { against: 0, neutral: 0, approve: 0 },
          status: "error",
          error: "load_failed",
        });
      } else {
        map.set(p.id, mapOverviewPayloadToStats(payload, p.id));
      }
    }
    return map;
  }, [ongoing, completed, payload, loadState]);

  const uniqueParticipants = payload?.aggregates?.unique_participants ?? 0;
  const stanceSelections = payload?.aggregates?.stance_selections ?? 0;
  const heading = overviewHeading(ongoing.length);
  const showPersonal = Boolean(authenticated);

  return (
    <section className="consensusOverview" aria-label="Consensus Overview">
      <header className="consensusOverview__header">
        <h1 className="sr-only">{heading}</h1>
        <p className="consensusOverview__aggregates" aria-live="polite">
          {loadState === "loading" ? (
            <span className="is-skeletonText">Loading participation…</span>
          ) : loadState === "error" ? (
            <span className="consensusOverview__errorInline">
              Could not load aggregates.{" "}
              <button type="button" className="consensusOverview__retry" onClick={retry}>
                Retry
              </button>
            </span>
          ) : (
            <>
              <span>
                <strong>{formatCount(uniqueParticipants)}</strong> unique participants
              </span>
              <span className="consensusOverview__sep" aria-hidden="true">
                ·
              </span>
              <span>
                <strong>{formatCount(stanceSelections)}</strong> stance selections
              </span>
            </>
          )}
        </p>
      </header>

      <div className="consensusOverview__ongoing" role="list">
        {ongoing.map((p) => (
          <div key={p.id} role="listitem">
            <OverviewCard
              proposal={p}
              stats={statsById.get(p.id) || null}
              onEnter={onEnterProposal}
              reducedMotion={reducedMotion}
              authenticated={showPersonal}
              proposalStances={showPersonal ? proposalStances : null}
            />
          </div>
        ))}
      </div>

      {completed.length ? (
        <div className="consensusOverview__completed">
          <h2 className="consensusOverview__completedHeading">Completed proposals</h2>
          <div className="consensusOverview__completedList" role="list">
            {completed.map((p) => (
              <div key={p.id} role="listitem">
                <OverviewCard
                  proposal={p}
                  stats={statsById.get(p.id) || null}
                  onEnter={onEnterProposal}
                  reducedMotion={reducedMotion}
                  completed
                  authenticated={showPersonal}
                  proposalStances={showPersonal ? proposalStances : null}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
