import { STANCE_COLORS, STANCE_LABELS } from "../utils/stanceColors";

const CHOICES = [
  { ui: "against", api: "against", className: "stanceChoiceCard__btn--against" },
  { ui: "neutral", api: "neutral", className: "stanceChoiceCard__btn--neutral" },
  { ui: "approve", api: "support", className: "stanceChoiceCard__btn--approve" },
];

/**
 * Floating glass card for picking / changing the logged-in user's stance.
 * Visual tone matches the New Stances intro panel.
 */
export function StanceChoiceCard({
  open,
  mode = "choose",
  currentStance = "",
  busy = false,
  onSelect,
  onDismiss,
}) {
  if (!open) return null;

  const title = mode === "change" ? "Change your stance" : "Choose your stance";
  const subtitle =
    mode === "change"
      ? "Pick a new position on BIP-110."
      : "Welcome. Where do you stand on BIP-110?";
  const canDismiss = mode === "change" && typeof onDismiss === "function";

  return (
    <div
      className="stanceChoiceOverlay"
      role="presentation"
      onClick={canDismiss ? onDismiss : undefined}
    >
      <div
        className="stanceChoiceCard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stance-choice-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="stanceChoiceCard__accent" aria-hidden="true" />
        <h2 id="stance-choice-title" className="stanceChoiceCard__title">
          {title}
        </h2>
        <p className="stanceChoiceCard__subtitle">{subtitle}</p>
        <div className="stanceChoiceCard__actions" role="group" aria-label="Stance options">
          {CHOICES.map((choice) => {
            const selected = currentStance === choice.ui;
            return (
              <button
                key={choice.ui}
                type="button"
                className={`stanceChoiceCard__btn ${choice.className}${selected ? " is-current" : ""}`}
                style={{ color: STANCE_COLORS[choice.ui] }}
                disabled={busy}
                aria-pressed={selected}
                onClick={() => onSelect?.(choice.ui, choice.api)}
              >
                {STANCE_LABELS[choice.ui]}
              </button>
            );
          })}
        </div>
        {canDismiss ? (
          <button
            type="button"
            className="stanceChoiceCard__dismiss"
            disabled={busy}
            onClick={onDismiss}
          >
            Keep current stance
          </button>
        ) : null}
      </div>
    </div>
  );
}
