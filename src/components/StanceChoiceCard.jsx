import { useId, useState } from "react";
import { STANCE_COLORS, STANCE_LABELS } from "../utils/stanceColors";
import { looksLikeStanceExplanationUrl } from "../utils/stanceExplanationUrl";

const CHOICES = [
  { ui: "against", api: "against", className: "stanceChoiceCard__btn--against" },
  { ui: "neutral", api: "neutral", className: "stanceChoiceCard__btn--neutral" },
  { ui: "approve", api: "support", className: "stanceChoiceCard__btn--approve" },
];

/**
 * Floating glass card for picking / changing the logged-in user's stance
 * and optionally attaching a verified X explanation post.
 */
export function StanceChoiceCard({
  open,
  mode = "choose",
  currentStance = "",
  busy = false,
  verifyBusy = false,
  stanceFrozen = false,
  existingExplanation = null,
  statusMessage = "",
  errorMessage = "",
  onSave,
  onRemoveExplanation,
  onDismiss,
  proposalLabel = "BIP-110",
  proposalGithubUrl = null,
  /** Structured active-proposal info from the catalog (choose + change modes). */
  proposalAbout = null,
  /** Optional one-line privacy/terms notice (first vote). */
  disclosureNotice = null,
}) {
  const formId = useId();
  const [draftStance, setDraftStance] = useState(currentStance || "");
  const [tweetUrl, setTweetUrl] = useState("");
  const [changingExplanation, setChangingExplanation] = useState(false);
  const [explanationDecision, setExplanationDecision] = useState(""); // confirm | replace | remove
  const [localError, setLocalError] = useState("");

  if (!open) return null;

  const aboutTitle = String(proposalAbout?.title || proposalLabel || "proposal").trim();
  const aboutDescription = String(proposalAbout?.description || "").trim();
  const aboutStatusLabel = String(proposalAbout?.statusLabel || "").trim();
  const aboutStatusDetail = String(proposalAbout?.statusDetail || "").trim();
  const aboutHeading = String(proposalAbout?.heading || `About ${aboutTitle}`).trim();
  const githubHref = String(proposalAbout?.githubUrl || proposalGithubUrl || "").trim();

  const title = stanceFrozen
    ? "Your stance explanation"
    : mode === "change"
      ? "Change your stance"
      : "Choose your stance";
  const subtitle = stanceFrozen
    ? `${aboutTitle} positions are locked. You can still manage a verified X explanation.`
    : mode === "change"
      ? `Pick a new position on ${aboutTitle}.`
      : `Welcome. Where do you stand on ${aboutTitle}?`;
  const canDismiss = typeof onDismiss === "function";
  const hasExisting = Boolean(existingExplanation?.canonical_url);
  const stanceChanged =
    Boolean(draftStance) && Boolean(currentStance) && draftStance !== currentStance;
  const needsExplanationDecision =
    !stanceFrozen && stanceChanged && hasExisting && !changingExplanation;
  const showUrlField =
    !hasExisting || changingExplanation || explanationDecision === "replace" || (!hasExisting && Boolean(draftStance));
  const anyBusy = busy || verifyBusy;

  function validateBeforeSave() {
    if (!draftStance && !stanceFrozen) {
      setLocalError("Select a position first.");
      return false;
    }
    if (needsExplanationDecision && !explanationDecision) {
      setLocalError("Choose what to do with your existing explanation for the new stance.");
      return false;
    }
    const urlNeeded =
      explanationDecision === "replace" ||
      changingExplanation ||
      (!hasExisting && String(tweetUrl).trim());
    if (urlNeeded && String(tweetUrl).trim()) {
      if (!looksLikeStanceExplanationUrl(tweetUrl)) {
        setLocalError("Enter a valid https://x.com/you/status/… link from your account.");
        return false;
      }
    }
    if ((explanationDecision === "replace" || changingExplanation) && !String(tweetUrl).trim()) {
      setLocalError("Paste a new explanation link, or cancel.");
      return false;
    }
    setLocalError("");
    return true;
  }

  async function handleSave(e) {
    e?.preventDefault?.();
    if (anyBusy || !validateBeforeSave()) return;
    const choice = CHOICES.find((c) => c.ui === draftStance) || CHOICES[1];
    await onSave?.({
      uiStance: choice.ui,
      apiStance: choice.api,
      tweetUrl: String(tweetUrl).trim(),
      explanationAction: explanationDecision || (changingExplanation ? "replace" : String(tweetUrl).trim() ? "attach" : "none"),
      stanceFrozen,
    });
  }

  async function handleRemoveOnly() {
    if (anyBusy) return;
    setLocalError("");
    await onRemoveExplanation?.();
  }

  return (
    <div
      className="stanceChoiceOverlay"
      role="presentation"
      onClick={canDismiss && !anyBusy ? onDismiss : undefined}
    >
      <div
        className="stanceChoiceCard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-title`}
        aria-describedby={`${formId}-subtitle`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="stanceChoiceCard__accent" aria-hidden="true" />
        <h2 id={`${formId}-title`} className="stanceChoiceCard__title">
          {title}
        </h2>
        <p id={`${formId}-subtitle`} className="stanceChoiceCard__subtitle">
          {subtitle}
        </p>
        {disclosureNotice ? (
          <div className="stanceChoiceCard__disclosure" role="note">
            {disclosureNotice}
          </div>
        ) : null}

        <div className="stanceChoiceCard__scrollBody">
          {(aboutDescription || aboutStatusDetail || githubHref) ? (
            <section
              className="stanceChoiceCard__about"
              aria-labelledby={`${formId}-about-heading`}
            >
              <h3 id={`${formId}-about-heading`} className="stanceChoiceCard__aboutHeading">
                {aboutHeading}
              </h3>
              {aboutStatusLabel ? (
                <p className="stanceChoiceCard__aboutStatus">
                  <span className="stanceChoiceCard__aboutStatusPill">{aboutStatusLabel}</span>
                  {aboutStatusDetail ? (
                    <span className="stanceChoiceCard__aboutStatusDetail">{aboutStatusDetail}</span>
                  ) : null}
                </p>
              ) : null}
              {aboutDescription ? (
                <p className="stanceChoiceCard__aboutDesc">{aboutDescription}</p>
              ) : null}
              {githubHref ? (
                <a
                  className="stanceChoiceCard__github"
                  href={githubHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Read the full ${aboutTitle} on GitHub`}
                >
                  Read the full BIP on GitHub
                </a>
              ) : null}
            </section>
          ) : null}

        <div className="stanceChoiceCard__actions" role="group" aria-label="Stance options">
          {CHOICES.map((choice) => {
            const selected = draftStance === choice.ui;
            return (
              <button
                key={choice.ui}
                type="button"
                className={`stanceChoiceCard__btn ${choice.className}${selected ? " is-current" : ""}`}
                style={{ color: STANCE_COLORS[choice.ui] }}
                disabled={anyBusy || stanceFrozen}
                aria-pressed={selected}
                onClick={() => {
                  if (stanceFrozen) return;
                  setDraftStance(choice.ui);
                  setLocalError("");
                  if (!hasExisting) setExplanationDecision("");
                }}
              >
                {STANCE_LABELS[choice.ui]}
              </button>
            );
          })}
        </div>

        {needsExplanationDecision ? (
          <fieldset className="stanceChoiceCard__explainDecision" disabled={anyBusy}>
            <legend>Your existing explanation was for the previous stance</legend>
            <label className="stanceChoiceCard__radio">
              <input
                type="radio"
                name={`${formId}-explain`}
                checked={explanationDecision === "confirm"}
                onChange={() => setExplanationDecision("confirm")}
              />
              Keep it — it still explains my new stance
            </label>
            <label className="stanceChoiceCard__radio">
              <input
                type="radio"
                name={`${formId}-explain`}
                checked={explanationDecision === "replace"}
                onChange={() => setExplanationDecision("replace")}
              />
              Replace with a different post
            </label>
            <label className="stanceChoiceCard__radio">
              <input
                type="radio"
                name={`${formId}-explain`}
                checked={explanationDecision === "remove"}
                onChange={() => setExplanationDecision("remove")}
              />
              Remove the explanation
            </label>
          </fieldset>
        ) : null}

        {hasExisting && !changingExplanation && explanationDecision !== "replace" ? (
          <div className="stanceChoiceCard__existing">
            <div className="stanceChoiceCard__existingLabel">Current explanation</div>
            <a
              className="stanceChoiceCard__existingLink"
              href={existingExplanation.canonical_url}
              target="_blank"
              rel="noreferrer"
            >
              {existingExplanation.canonical_url}
            </a>
            {!existingExplanation.matches_current_stance ? (
              <p className="stanceChoiceCard__hint">
                Hidden publicly until you confirm it still matches your current stance.
              </p>
            ) : null}
            <div className="stanceChoiceCard__existingActions">
              <button
                type="button"
                className="stanceChoiceCard__secondary"
                disabled={anyBusy}
                onClick={() => {
                  setChangingExplanation(true);
                  setExplanationDecision("replace");
                  setTweetUrl("");
                }}
              >
                Change explanation
              </button>
              <button
                type="button"
                className="stanceChoiceCard__secondary"
                disabled={anyBusy}
                onClick={handleRemoveOnly}
              >
                Remove explanation
              </button>
            </div>
          </div>
        ) : null}

        {showUrlField && explanationDecision !== "remove" && explanationDecision !== "confirm" ? (
          <div className="stanceChoiceCard__urlBlock">
            <label className="stanceChoiceCard__urlLabel" htmlFor={`${formId}-url`}>
              Explain your stance on X (optional)
            </label>
            <p className="stanceChoiceCard__hint">
              Optional. Add a link to a post from your connected X account, or leave this blank and
              save your stance.
            </p>
            <input
              id={`${formId}-url`}
              className="stanceChoiceCard__urlInput"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://x.com/you/status/…"
              value={tweetUrl}
              disabled={anyBusy}
              onChange={(e) => {
                setTweetUrl(e.target.value);
                setLocalError("");
              }}
            />
            {changingExplanation || explanationDecision === "replace" ? (
              <button
                type="button"
                className="stanceChoiceCard__secondary"
                disabled={anyBusy}
                onClick={() => {
                  setChangingExplanation(false);
                  setExplanationDecision("");
                  setTweetUrl("");
                }}
              >
                Cancel link change
              </button>
            ) : null}
          </div>
        ) : null}
        </div>

        <div className="stanceChoiceCard__status" aria-live="polite">
          {busy ? <span>Saving position…</span> : null}
          {verifyBusy ? <span>Verifying explanation on X…</span> : null}
          {statusMessage ? <span>{statusMessage}</span> : null}
          {localError || errorMessage ? (
            <span className="stanceChoiceCard__error" role="alert">
              {localError || errorMessage}
            </span>
          ) : null}
        </div>

        <div className="stanceChoiceCard__footer">
          <button
            type="button"
            className="stanceChoiceCard__save"
            disabled={anyBusy || (!stanceFrozen && !draftStance)}
            onClick={handleSave}
          >
            {stanceFrozen && !String(tweetUrl).trim() && explanationDecision !== "remove"
              ? hasExisting && !changingExplanation
                ? "Done"
                : "Save explanation"
              : "Save"}
          </button>
          {canDismiss ? (
            <button
              type="button"
              className="stanceChoiceCard__dismiss"
              disabled={anyBusy}
              onClick={onDismiss}
            >
              {stanceFrozen ? "Close" : mode === "change" ? "Keep current stance" : "Not now"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
