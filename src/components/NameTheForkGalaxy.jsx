import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteNameTheForkVote,
  fetchNameTheFork,
  postNameTheForkCandidate,
  postNameTheForkHide,
  postNameTheForkVote,
} from "../api/nameTheFork";
import {
  friendlyNameTheForkError,
  graphemeLength,
  NAME_THE_FORK_MAX_CHARS,
  NAME_THE_FORK_THEME,
  normalizeCandidateName,
} from "../utils/nameTheFork";
import { applySparseFitCap } from "../utils/sparseFitCap";

const AVATAR_CAP = 24;

function missingAvatarSrc() {
  return "/avatars/_missing.svg";
}

function resolveVoterAvatar(voter) {
  const path = String(voter?.avatar_path || "").trim();
  if (path) return path.startsWith("/") ? path : `/${path}`;
  const url = String(voter?.avatar_url || "").trim();
  if (url) return url;
  return missingAvatarSrc();
}

function avatarSizePx(voterCount, viewportShort) {
  const fitScale = applySparseFitCap({
    fitScale: 1,
    maxNodeSide: 48,
    visibleNodeCount: Math.max(1, voterCount),
    viewportWidth: viewportShort,
    viewportHeight: viewportShort,
    userScaleMul: 1,
  });
  return Math.min(48, Math.max(22, 48 * (Number(fitScale) || 1)));
}

function LoadingSkeletons() {
  return (
    <div className="nameTheFork__skeletons" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="nameTheFork__skeleton" />
      ))}
    </div>
  );
}

export function NameTheForkGalaxy({
  apiBase = "",
  reducedMotion = false,
  authenticated = false,
  authBusy = false,
  onLogin,
  onReturn,
}) {
  const [payload, setPayload] = useState(null);
  const [loadState, setLoadState] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [viewportShort, setViewportShort] = useState(800);
  const fetchControllerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fetchControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () => setViewportShort(Math.min(window.innerWidth, window.innerHeight));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const reload = useCallback(async () => {
    fetchControllerRef.current?.abort();
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    setLoadState("loading");
    try {
      const data = await fetchNameTheFork({ apiBase, signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      setPayload(data);
      setSelectedId(data?.me?.selected_candidate_id || null);
      setLoadState("ok");
    } catch {
      if (controller.signal.aborted || !mountedRef.current) return;
      setLoadState("error");
    }
  }, [apiBase]);

  useEffect(() => {
    void reload();
  }, [reload, authenticated]);

  const me = payload?.me;
  const candidates = payload?.candidates || [];
  const mySelection = me?.selected_candidate_id || null;
  const customUsed = Boolean(me?.has_custom_slot_used);
  const canModerate = Boolean(me?.can_moderate);

  const customPreview = useMemo(() => normalizeCandidateName(customName), [customName]);
  const remaining = customPreview.ok
    ? NAME_THE_FORK_MAX_CHARS - customPreview.length
    : NAME_THE_FORK_MAX_CHARS - graphemeLength(String(customName || "").trim());

  async function ensureAuth() {
    if (authenticated) return true;
    onLogin?.();
    return false;
  }

  async function runWrite(fn, successMessage) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const next = await fn();
      if (!mountedRef.current) return;
      setPayload(next);
      setSelectedId(next?.me?.selected_candidate_id || null);
      setConfirmRemove(false);
      setSuggestOpen(false);
      setCustomName("");
      setStatus(successMessage || "");
    } catch (e) {
      if (!mountedRef.current) return;
      setError(friendlyNameTheForkError(e?.code || e?.message));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function onVote() {
    if (!(await ensureAuth())) return;
    const id = selectedId || mySelection;
    if (!id) {
      setError("Choose a name first.");
      return;
    }
    const changing = Boolean(mySelection && id !== mySelection);
    await runWrite(
      () => postNameTheForkVote({ apiBase, candidateId: id }),
      changing ? "Vote changed." : "Vote recorded."
    );
  }

  async function onRemove() {
    if (!(await ensureAuth())) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    await runWrite(() => deleteNameTheForkVote({ apiBase }), "Vote removed.");
  }

  async function onSuggest() {
    if (!(await ensureAuth())) return;
    if (!customPreview.ok) {
      setError(friendlyNameTheForkError("invalid_name"));
      return;
    }
    await runWrite(
      () => postNameTheForkCandidate({ apiBase, displayName: customPreview.displayName }),
      "Custom name submitted."
    );
  }

  async function onHide(candidateId) {
    if (!canModerate) return;
    await runWrite(() => postNameTheForkHide({ apiBase, candidateId }), "Candidate hidden.");
  }

  const theme = NAME_THE_FORK_THEME;
  const voteLabel = !mySelection ? "Vote" : selectedId && selectedId !== mySelection ? "Change vote" : "Vote";

  return (
    <section
      className={`nameTheFork${reducedMotion ? " is-static" : ""}`}
      aria-label="Name the Fork"
      style={{
        "--ntf-accent": theme.accent,
        "--ntf-glow": theme.accentSoft,
        "--ntf-from": theme.nebulaFrom,
        "--ntf-to": theme.nebulaTo,
        "--ntf-aura": theme.aura,
      }}
    >
      <header className="nameTheFork__header">
        <button type="button" className="nameTheFork__return" onClick={() => onReturn?.()}>
          Return to consensus
        </button>
        <h1 className="nameTheFork__title">Name the Fork</h1>
        <p className="nameTheFork__subtitle">
          An informal community naming poll for the new PoW fork — not an official protocol decision.
        </p>
        <p className="nameTheFork__totals" aria-live="polite">
          {loadState === "loading"
            ? "Loading votes…"
            : loadState === "error"
              ? "Could not load the poll."
              : `${payload?.total_voters || 0} unique voters`}
        </p>
        {loadState === "error" ? (
          <button type="button" className="nameTheFork__retry" onClick={() => void reload()}>
            Retry
          </button>
        ) : null}
      </header>

      <div className="nameTheFork__body">
        <div className="nameTheFork__rankScroll" role="list" aria-label="Ranked name candidates">
          {loadState === "loading" && !candidates.length ? <LoadingSkeletons /> : null}
          {loadState === "ok" && !candidates.length ? (
            <p className="nameTheFork__empty">No visible candidates yet.</p>
          ) : null}
          {candidates.map((c) => {
            const voters = c.voters || [];
            const shown = voters.slice(0, AVATAR_CAP);
            const overflow = Math.max(0, voters.length - shown.length);
            const size = avatarSizePx(Math.max(1, shown.length), viewportShort);
            const selected = (selectedId || mySelection) === c.id;
            const isMine = mySelection === c.id;
            return (
              <article
                key={c.id}
                role="listitem"
                className={`nameTheForkCluster${selected ? " is-selected" : ""}${
                  isMine ? " is-mine" : ""
                }`}
              >
                <button
                  type="button"
                  className="nameTheForkCluster__hit"
                  aria-pressed={selected}
                  aria-label={`Select ${c.display_name}`}
                  disabled={busy}
                  onClick={() => {
                    setSelectedId(c.id);
                    setConfirmRemove(false);
                    setError("");
                  }}
                >
                  <div className="nameTheForkCluster__meta">
                    <span className="nameTheForkCluster__rank">#{c.rank}</span>
                    <strong className="nameTheForkCluster__name">{c.display_name}</strong>
                    <span className="nameTheForkCluster__counts">
                      {c.vote_count} {c.vote_count === 1 ? "vote" : "votes"} · {c.percentage}%
                    </span>
                    {!c.is_seed && c.proposer_handle ? (
                      <span className="nameTheForkCluster__proposed">
                        Proposed by @{c.proposer_handle}
                      </span>
                    ) : null}
                  </div>
                  <div className="nameTheForkCluster__orbit" aria-hidden="true">
                    {shown.map((v, i) => (
                      <img
                        key={`${v.x_user_id}-${i}`}
                        className="nameTheForkCluster__avatar"
                        src={resolveVoterAvatar(v)}
                        alt=""
                        width={size}
                        height={size}
                        style={{
                          width: size,
                          height: size,
                          ["--i"]: i,
                          ["--n"]: Math.max(1, shown.length),
                        }}
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          e.currentTarget.src = missingAvatarSrc();
                        }}
                      />
                    ))}
                    {overflow > 0 ? (
                      <span className="nameTheForkCluster__more">+{overflow} more</span>
                    ) : null}
                    {voters.length === 0 ? <span className="nameTheForkCluster__emptyDot" /> : null}
                  </div>
                </button>
                {canModerate && !c.is_seed ? (
                  <button
                    type="button"
                    className="nameTheForkCluster__hide"
                    disabled={busy}
                    onClick={() => void onHide(c.id)}
                  >
                    Hide
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>

        <aside className="nameTheFork__panel" aria-label="Voting controls">
          <div className="nameTheFork__panelTitle">Your choice</div>
          <p className="nameTheFork__panelHint">
            {authenticated
              ? mySelection
                ? "You can change or remove your vote anytime."
                : "Pick a candidate above, then vote."
              : "Anyone can view results. Sign in with X to vote or suggest a name."}
          </p>
          {mySelection ? (
            <p className="nameTheFork__current">
              Current vote:{" "}
              <strong>
                {candidates.find((c) => c.id === mySelection)?.display_name || "Hidden choice"}
              </strong>
            </p>
          ) : null}
          <div className="nameTheFork__actions">
            <button
              type="button"
              className="toolbarBtn"
              disabled={busy || authBusy || (!selectedId && !mySelection)}
              onClick={() => void onVote()}
            >
              {voteLabel}
            </button>
            {mySelection ? (
              <button
                type="button"
                className="toolbarBtn"
                disabled={busy || authBusy}
                onClick={() => void onRemove()}
              >
                {confirmRemove ? "Confirm remove" : "Remove vote"}
              </button>
            ) : null}
            {!authenticated ? (
              <button type="button" className="toolbarBtn" disabled={authBusy} onClick={() => onLogin?.()}>
                Sign in with X
              </button>
            ) : null}
          </div>

          {!customUsed ? (
            <div className="nameTheFork__suggest">
              {!suggestOpen ? (
                <button
                  type="button"
                  className="nameTheFork__suggestToggle"
                  disabled={busy || authBusy}
                  onClick={() => {
                    setSuggestOpen(true);
                    setError("");
                  }}
                >
                  Suggest a name
                </button>
              ) : (
                <>
                  <label className="nameTheFork__suggestLabel" htmlFor="ntf-custom-name">
                    Custom name (uses your one suggestion slot and votes for it)
                  </label>
                  <input
                    id="ntf-custom-name"
                    className="nameTheFork__suggestInput"
                    maxLength={NAME_THE_FORK_MAX_CHARS * 2}
                    value={customName}
                    disabled={busy}
                    placeholder="e.g. BitNova"
                    onChange={(e) => setCustomName(e.target.value)}
                  />
                  <div className="nameTheFork__suggestMeta">
                    <span>{remaining} left</span>
                    <span>Max {NAME_THE_FORK_MAX_CHARS} characters</span>
                  </div>
                  <button
                    type="button"
                    className="toolbarBtn"
                    disabled={busy || authBusy || !customPreview.ok}
                    onClick={() => void onSuggest()}
                  >
                    Submit name & vote
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="nameTheFork__panelHint">You’ve already used your custom-name slot.</p>
          )}

          {status ? (
            <p className="nameTheFork__status" role="status">
              {status}
            </p>
          ) : null}
          {error ? (
            <p className="nameTheFork__error" role="alert">
              {error}
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
