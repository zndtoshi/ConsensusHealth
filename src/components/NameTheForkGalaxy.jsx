import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteNameTheForkVote,
  fetchNameTheFork,
  postNameTheForkApprove,
  postNameTheForkCandidate,
  postNameTheForkHide,
  postNameTheForkReject,
  postNameTheForkVote,
} from "../api/nameTheFork";
import {
  clearPendingNameTheForkVote,
  createCandidateVoteWriteGate,
  decidePendingNameTheForkVoteAction,
  friendlyNameTheForkError,
  graphemeLength,
  NAME_THE_FORK_MAX_CHARS,
  NAME_THE_FORK_THEME,
  NAME_THE_FORK_TITLE,
  normalizeCandidateName,
  readPendingNameTheForkVote,
  runExclusiveCandidateVoteWrite,
  writePendingNameTheForkVote,
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
    maxNodeSide: 40,
    visibleNodeCount: Math.max(1, voterCount),
    viewportWidth: viewportShort,
    viewportHeight: viewportShort,
    userScaleMul: 1,
  });
  return Math.min(40, Math.max(20, 40 * (Number(fitScale) || 1)));
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

function formatSubmittedAt(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
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
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRejectId, setConfirmRejectId] = useState(null);
  const [viewportShort, setViewportShort] = useState(800);
  const fetchControllerRef = useRef(null);
  const mountedRef = useRef(true);
  const candidateVoteGateRef = useRef(createCandidateVoteWriteGate());
  const consumedPendingIdRef = useRef(null);

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
  const mySubmission = me?.my_submission || null;
  const pendingSuggestions = canModerate ? payload?.pending_suggestions || [] : [];

  const customPreview = useMemo(() => normalizeCandidateName(customName), [customName]);
  const remaining = customPreview.ok
    ? NAME_THE_FORK_MAX_CHARS - customPreview.length
    : NAME_THE_FORK_MAX_CHARS - graphemeLength(String(customName || "").trim());

  const applyPayload = useCallback((next) => {
    if (!mountedRef.current) return;
    setPayload(next);
    setConfirmRemove(false);
    setConfirmRejectId(null);
  }, []);

  async function runWrite(fn, successMessage) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const next = await fn();
      applyPayload(next);
      setStatus(successMessage || "");
      return true;
    } catch (e) {
      if (!mountedRef.current) return false;
      setError(friendlyNameTheForkError(e?.code || e?.message));
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  /** Candidate-vote POSTs only — exclusive gate; remove/suggest/moderation use runWrite. */
  async function executeCandidateVote(candidateId, changing) {
    return runExclusiveCandidateVoteWrite({
      gate: candidateVoteGateRef.current,
      write: () => postNameTheForkVote({ apiBase, candidateId }),
      onBusy: (nextBusy) => {
        if (!mountedRef.current) return;
        setBusy(nextBusy);
        if (nextBusy) {
          setError("");
          setStatus("");
        }
      },
      onSuccess: (next) => {
        if (!mountedRef.current) return;
        applyPayload(next);
        setStatus(changing ? "Vote changed." : "Vote recorded.");
      },
      onError: (e) => {
        if (!mountedRef.current) return;
        setError(friendlyNameTheForkError(e?.code || e?.message));
      },
    });
  }

  async function voteForCandidate(candidateId) {
    const id = String(candidateId || "").trim();
    if (!id || authBusy) return;
    if (!authenticated) {
      writePendingNameTheForkVote(id);
      // Allow a later login cycle to consume this new intent.
      consumedPendingIdRef.current = null;
      onLogin?.();
      return;
    }
    if (mySelection === id) {
      setError("");
      setStatus("This is your current vote.");
      return;
    }
    // Synchronous gate — do not rely on React `busy` for concurrency.
    await executeCandidateVote(id, Boolean(mySelection));
  }

  // Complete a single intended vote after popup login (reusable across logout cycles).
  useEffect(() => {
    if (!authenticated) {
      consumedPendingIdRef.current = null;
      return;
    }
    const decision = decidePendingNameTheForkVoteAction({
      pendingCandidateId: readPendingNameTheForkVote(),
      authenticated: true,
      authBusy,
      pollReady: loadState === "ok",
      castInFlight: candidateVoteGateRef.current.isHeld(),
      approvedCandidateIds: candidates.map((c) => c.id),
      selectedCandidateId: mySelection,
      consumedCandidateId: consumedPendingIdRef.current,
    });
    if (decision.type === "wait") return;
    if (decision.type === "clear") {
      consumedPendingIdRef.current = readPendingNameTheForkVote();
      clearPendingNameTheForkVote();
      return;
    }
    if (decision.type === "already_selected") {
      consumedPendingIdRef.current = decision.candidateId;
      clearPendingNameTheForkVote();
      setStatus("This is your current vote.");
      return;
    }
    if (decision.type !== "cast") return;
    // Acquire first; only clear pending once this cast owns the exclusive vote write.
    void runExclusiveCandidateVoteWrite({
      gate: candidateVoteGateRef.current,
      write: () => {
        consumedPendingIdRef.current = decision.candidateId;
        clearPendingNameTheForkVote();
        return postNameTheForkVote({ apiBase, candidateId: decision.candidateId });
      },
      onBusy: (nextBusy) => {
        if (!mountedRef.current) return;
        setBusy(nextBusy);
        if (nextBusy) {
          setError("");
          setStatus("");
        }
      },
      onSuccess: (next) => {
        if (!mountedRef.current) return;
        applyPayload(next);
        setStatus(decision.changing ? "Vote changed." : "Vote recorded.");
      },
      onError: (e) => {
        if (!mountedRef.current) return;
        setError(friendlyNameTheForkError(e?.code || e?.message));
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional auth/poll settlement trigger
  }, [authenticated, authBusy, busy, loadState, candidates, mySelection, apiBase]);

  async function onRemove() {
    if (!authenticated) {
      onLogin?.();
      return;
    }
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    await runWrite(() => deleteNameTheForkVote({ apiBase }), "Vote removed.");
  }

  async function onSuggest() {
    if (!authenticated) {
      onLogin?.();
      return;
    }
    if (!customPreview.ok) {
      setError(friendlyNameTheForkError("invalid_name"));
      return;
    }
    const ok = await runWrite(
      () => postNameTheForkCandidate({ apiBase, displayName: customPreview.displayName }),
      "Suggestion submitted for review."
    );
    if (ok) {
      setSuggestOpen(false);
      setCustomName("");
    }
  }

  async function onHide(candidateId) {
    if (!canModerate) return;
    await runWrite(() => postNameTheForkHide({ apiBase, candidateId }), "Candidate hidden.");
  }

  async function onApprove(candidateId) {
    if (!canModerate) return;
    await runWrite(() => postNameTheForkApprove({ apiBase, candidateId }), "Suggestion approved.");
  }

  async function onReject(candidateId) {
    if (!canModerate) return;
    if (confirmRejectId !== candidateId) {
      setConfirmRejectId(candidateId);
      return;
    }
    await runWrite(() => postNameTheForkReject({ apiBase, candidateId }), "Suggestion rejected.");
  }

  const theme = NAME_THE_FORK_THEME;
  const selectedName =
    candidates.find((c) => c.id === mySelection)?.display_name || null;

  return (
    <section
      className={`nameTheFork${reducedMotion ? " is-static" : ""}`}
      aria-label={NAME_THE_FORK_TITLE}
      style={{
        "--ntf-accent": theme.accent,
        "--ntf-glow": theme.accentSoft,
        "--ntf-from": theme.nebulaFrom,
        "--ntf-to": theme.nebulaTo,
        "--ntf-aura": theme.aura,
      }}
    >
      <div className="nameTheFork__shell">
        <header className="nameTheFork__header">
          <button type="button" className="nameTheFork__return" onClick={() => onReturn?.()}>
            Return to consensus
          </button>
          <h1 className="nameTheFork__title">{NAME_THE_FORK_TITLE}</h1>
          <p className="nameTheFork__subtitle">
            An informal community naming poll for the new PoW fork — not an official protocol
            decision.
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

        {authenticated && mySelection && selectedName ? (
          <div className="nameTheFork__voteChip" aria-live="polite">
            <span>
              Your vote: <strong>{selectedName}</strong>
            </span>
            <button
              type="button"
              className="nameTheFork__chipBtn"
              disabled={busy || authBusy}
              onClick={() => void onRemove()}
            >
              {confirmRemove ? "Confirm remove" : "Remove vote"}
            </button>
          </div>
        ) : authenticated ? (
          <p className="nameTheFork__voteHint">Tap a name below to cast your vote.</p>
        ) : (
          <p className="nameTheFork__voteHint">
            Anyone can view results. Sign in with X to vote or suggest a name.
          </p>
        )}

        {mySubmission?.status === "pending" ? (
          <div className="nameTheFork__pendingCard" role="status">
            <div className="nameTheFork__pendingLabel">Pending review</div>
            <div className="nameTheFork__pendingName">{mySubmission.display_name}</div>
            <p className="nameTheFork__pendingCopy">
              Your suggestion is waiting for admin review. It is not public or votable yet.
            </p>
          </div>
        ) : null}
        {mySubmission?.status === "rejected" ? (
          <div className="nameTheFork__pendingCard nameTheFork__pendingCard--rejected" role="status">
            <p className="nameTheFork__pendingCopy">
              Your previous suggestion was not approved. You may suggest another name.
            </p>
          </div>
        ) : null}

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
            const isMine = mySelection === c.id;
            return (
              <article
                key={c.id}
                role="listitem"
                className={`nameTheForkCluster${isMine ? " is-mine" : ""}`}
              >
                <button
                  type="button"
                  className="nameTheForkCluster__hit"
                  aria-pressed={isMine}
                  aria-label={`Vote for ${c.display_name}`}
                  disabled={busy || authBusy}
                  onClick={() => void voteForCandidate(c.id)}
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

        {!customUsed || mySubmission?.status === "rejected" ? (
          <div className="nameTheFork__suggestCard">
            {!suggestOpen ? (
              <button
                type="button"
                className="nameTheFork__suggestToggle"
                disabled={busy || authBusy || (customUsed && mySubmission?.status !== "rejected")}
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
                  Custom name (one suggestion slot; requires admin approval before it is public)
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
                <div className="nameTheFork__suggestActions">
                  {!authenticated ? (
                    <button
                      type="button"
                      className="toolbarBtn"
                      disabled={authBusy}
                      onClick={() => onLogin?.()}
                    >
                      Sign in with X
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="toolbarBtn"
                      disabled={busy || authBusy || !customPreview.ok}
                      onClick={() => void onSuggest()}
                    >
                      Submit for review
                    </button>
                  )}
                  <button
                    type="button"
                    className="nameTheFork__chipBtn"
                    disabled={busy}
                    onClick={() => {
                      setSuggestOpen(false);
                      setCustomName("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        ) : mySubmission?.status === "pending" ? null : (
          <p className="nameTheFork__voteHint">You’ve already used your custom-name slot.</p>
        )}

        {canModerate ? (
          <section className="nameTheFork__admin" aria-label="Pending suggestions">
            <h2 className="nameTheFork__adminTitle">Pending suggestions</h2>
            {pendingSuggestions.length === 0 ? (
              <p className="nameTheFork__voteHint">No pending suggestions.</p>
            ) : (
              <ul className="nameTheFork__adminList">
                {pendingSuggestions.map((item) => (
                  <li key={item.id} className="nameTheFork__adminRow">
                    <div className="nameTheFork__adminMeta">
                      <strong>{item.display_name}</strong>
                      <span>
                        {item.proposer_handle ? `@${item.proposer_handle}` : "unknown proposer"} ·{" "}
                        {formatSubmittedAt(item.created_at)}
                      </span>
                    </div>
                    <div className="nameTheFork__adminActions">
                      <button
                        type="button"
                        className="toolbarBtn"
                        disabled={busy}
                        onClick={() => void onApprove(item.id)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="nameTheFork__chipBtn nameTheFork__chipBtn--danger"
                        disabled={busy}
                        onClick={() => void onReject(item.id)}
                      >
                        {confirmRejectId === item.id ? "Confirm reject" : "Reject"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

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
      </div>
    </section>
  );
}
