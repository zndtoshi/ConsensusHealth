import { useEffect, useId, useRef, useState } from "react";

function normalizeHandle(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function getFocusable(container) {
  if (!container) return [];
  const nodes = container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  return Array.from(nodes).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
}

/**
 * Destructive confirmation: type current handle to delete account + data.
 * Parent performs POST /api/me/delete via onConfirm({ confirmHandle }).
 * Remount with a new `key` when opening to clear the input.
 */
export function DeleteAccountDialog({
  open,
  handle = "",
  busy = false,
  errorMessage = "",
  returnFocusRef = null,
  onConfirm,
  onCancel,
}) {
  const titleId = useId();
  const descId = useId();
  const inputId = useId();
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const [typed, setTyped] = useState("");

  const expected = normalizeHandle(handle);
  const typedNorm = normalizeHandle(typed);
  const matches = Boolean(expected) && typedNorm === expected;

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocusedRef.current =
      returnFocusRef?.current ||
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusToRestore = previouslyFocusedRef.current;

    const overlay = dialogRef.current?.closest?.(".deleteAccountOverlay") || dialogRef.current;
    const restoreInert = [];
    try {
      for (const el of Array.from(document.body.children)) {
        if (el === overlay || (typeof el.contains === "function" && el.contains(overlay))) continue;
        if ("inert" in el) {
          const was = Boolean(el.inert);
          el.inert = true;
          restoreInert.push(() => {
            el.inert = was;
          });
        } else {
          const prev = el.getAttribute("aria-hidden");
          el.setAttribute("aria-hidden", "true");
          restoreInert.push(() => {
            if (prev == null) el.removeAttribute("aria-hidden");
            else el.setAttribute("aria-hidden", prev);
          });
        }
      }
    } catch {
      /* ignore */
    }

    const t = window.setTimeout(() => inputRef.current?.focus?.(), 0);

    function onKeyDown(e) {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel?.();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const list = getFocusable(dialogRef.current);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      for (const restore of restoreInert) {
        try {
          restore();
        } catch {
          /* ignore */
        }
      }
      const restoreFocus = focusToRestore;
      if (restoreFocus && typeof restoreFocus.focus === "function") {
        try {
          restoreFocus.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, [open, busy, onCancel, returnFocusRef]);

  if (!open) return null;

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (busy || !matches) return;
    await onConfirm?.({ confirmHandle: typedNorm });
  }

  return (
    <div
      className="deleteAccountOverlay"
      role="presentation"
      onClick={() => {
        if (!busy) onCancel?.();
      }}
    >
      <div
        ref={dialogRef}
        className="deleteAccountDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="deleteAccountDialog__title">
          Delete my account and data
        </h2>
        <div id={descId} className="deleteAccountDialog__body">
          <p>This permanently removes:</p>
          <ul>
            <li>Your signed-in identity and session</li>
            <li>Proposal stances, stance history, and explanation links</li>
            <li>Account preferences</li>
            <li>Locally stored avatar file for your account (when present)</li>
          </ul>
          <p>
            Live aggregates and statistics are recomputed after deletion. Backups may retain data
            until they age out of retention. This cannot be undone.
          </p>
          <p>
            Type your handle <strong>@{expected || "handle"}</strong> to confirm (with or without @).
          </p>
        </div>
        <form className="deleteAccountDialog__form" onSubmit={handleSubmit}>
          <label className="deleteAccountDialog__label" htmlFor={inputId}>
            Confirm handle
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="deleteAccountDialog__input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            disabled={busy}
            placeholder="@yourhandle"
            onChange={(e) => setTyped(e.target.value)}
          />
          {errorMessage ? (
            <p className="deleteAccountDialog__error" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <div className="deleteAccountDialog__actions">
            <button
              type="button"
              className="deleteAccountDialog__cancel"
              disabled={busy}
              onClick={() => onCancel?.()}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="deleteAccountDialog__confirm"
              disabled={busy || !matches}
            >
              {busy ? "Deleting…" : "Delete account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
