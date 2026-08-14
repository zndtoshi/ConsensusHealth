import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  listEnabledProposals,
  proposalGithubUrl,
  getProposalById,
  isFinalProposal,
  isOngoingProposal,
} from "../config/proposals";

function proposalStatusLabel(proposal) {
  if (!proposal) return "";
  if (isFinalProposal(proposal)) return "FINAL SNAPSHOT";
  if (isOngoingProposal(proposal)) return "ONGOING";
  if (proposal.adminOnly) return "ADMIN PREVIEW";
  return "";
}

const OVERVIEW_OPTION_INDEX = 0;

/**
 * Centered BIP dropdown — sole galaxy navigation control.
 * Includes an "All proposals" entry to return to Consensus Overview.
 */
export function GalaxyHeaderNav({
  proposalId,
  catalog,
  disabled = false,
  onNavigate,
  onOverview,
}) {
  const list = useMemo(() => listEnabledProposals(catalog), [catalog]);
  const current = getProposalById(proposalId, list) || list[0];
  const theme = current?.visualTheme;
  const proposalUrl = proposalGithubUrl(current?.id);
  const isFinalSnapshot = isFinalProposal(current);
  const optionCount = list.length + 1;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const restoreFocusAfterTravelRef = useRef(false);
  const listboxId = useId();

  function focusTrigger() {
    triggerRef.current?.focus?.();
  }

  function closeMenu({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) {
      queueMicrotask(() => focusTrigger());
    }
  }
  const closeMenuRef = useRef(closeMenu);
  useEffect(() => {
    closeMenuRef.current = closeMenu;
  });

  function openMenu() {
    if (disabled) return;
    const idx = Math.max(0, list.findIndex((p) => p.id === current?.id));
    setActiveIndex(idx + 1);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenuRef.current({ restoreFocus: true });
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`);
    if (el && typeof el.focus === "function") el.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (disabled) return;
    if (!restoreFocusAfterTravelRef.current) return;
    restoreFocusAfterTravelRef.current = false;
    focusTrigger();
  }, [disabled]);

  function selectOverview() {
    if (disabled) {
      closeMenu({ restoreFocus: true });
      return;
    }
    closeMenu({ restoreFocus: false });
    restoreFocusAfterTravelRef.current = true;
    onOverview?.();
  }

  function selectProposal(id) {
    if (!id || disabled) {
      closeMenu({ restoreFocus: true });
      return;
    }
    if (id === current?.id) {
      closeMenu({ restoreFocus: true });
      return;
    }
    closeMenu({ restoreFocus: false });
    restoreFocusAfterTravelRef.current = true;
    onNavigate?.(id);
  }

  function onTriggerKeyDown(e) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
  }

  function onOptionKeyDown(e, index) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((index + 1) % optionCount);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((index - 1 + optionCount) % optionCount);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(Math.max(0, optionCount - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (index === OVERVIEW_OPTION_INDEX) selectOverview();
      else selectProposal(list[index - 1]?.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu({ restoreFocus: true });
    } else if (e.key === "Tab") {
      // Do not intercept Tab — close and let focus move naturally.
      setOpen(false);
    }
  }

  if (!current) return null;

  return (
    <div className="galaxyHeaderNav" ref={rootRef}>
      <div className="galaxyHeaderNav__selector">
        <div className="galaxyHeaderNav__closed">
          <button
            ref={triggerRef}
            type="button"
            className="galaxyHeaderNav__trigger"
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            onClick={() => {
              if (disabled) return;
              if (open) closeMenu();
              else openMenu();
            }}
            onKeyDown={onTriggerKeyDown}
          >
            <div className="galaxyHeaderNav__titleRow">
              {isFinalSnapshot ? (
                <svg className="galaxyHeaderNav__lock" viewBox="0 0 16 16" aria-label="Final locked snapshot">
                  <path
                    fill="currentColor"
                    d="M4.75 6V4.75a3.25 3.25 0 0 1 6.5 0V6h.5A1.25 1.25 0 0 1 13 7.25v6.5A1.25 1.25 0 0 1 11.75 15h-7.5A1.25 1.25 0 0 1 3 13.75v-6.5A1.25 1.25 0 0 1 4.25 6h.5Zm1.5 0h3.5V4.75a1.75 1.75 0 0 0-3.5 0V6Z"
                  />
                </svg>
              ) : null}
              <div
                className="galaxyHeaderNav__current"
                style={{
                  color: theme?.accent,
                  textShadow: theme
                    ? `0 0 10px ${theme.accentSoft}, 0 0 22px ${theme.accentSoft}`
                    : undefined,
                }}
              >
                {current.title}
              </div>
              <svg className="galaxyHeaderNav__chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  fill="currentColor"
                  d="M3.2 5.7a.75.75 0 0 1 1.06.05L8 9.7l3.74-3.95a.75.75 0 1 1 1.1 1.02l-4.28 4.52a.75.75 0 0 1-1.1 0L3.15 6.77a.75.75 0 0 1 .05-1.07Z"
                />
              </svg>
            </div>
          </button>
          <div className="galaxyHeaderNav__descRow">
            <span className="galaxyHeaderNav__description">{current.description}</span>
            {proposalUrl ? (
              <a
                className="galaxyHeaderNav__github"
                href={proposalUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open the official ${current.shortName} proposal on GitHub`}
                aria-label={`Open the official ${current.shortName} proposal on GitHub`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    fill="currentColor"
                    d="M12 .7a11.3 11.3 0 0 0-3.57 22.02c.56.1.77-.24.77-.54v-2.12c-3.12.68-3.78-1.33-3.78-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.4-1.22.71-1.5-2.49-.28-5.1-1.25-5.1-5.58 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.11 1.16A10.8 10.8 0 0 1 12 6.18c.96 0 1.92.13 2.82.38 2.16-1.46 3.1-1.16 3.1-1.16.62 1.55.23 2.7.12 2.98.72.79 1.16 1.8 1.16 3.03 0 4.34-2.62 5.29-5.12 5.57.4.35.76 1.03.76 2.08v3.12c0 .3.2.65.77.54A11.3 11.3 0 0 0 12 .7Z"
                  />
                </svg>
              </a>
            ) : null}
          </div>
        </div>

        {open ? (
          <ul
            ref={listRef}
            id={listboxId}
            className="galaxyHeaderNav__listbox"
            role="listbox"
            aria-label="Consensus proposals"
            tabIndex={-1}
          >
            <li role="presentation" className="galaxyHeaderNav__overviewOption">
              <button
                type="button"
                role="option"
                data-option-index={OVERVIEW_OPTION_INDEX}
                className={`galaxyHeaderNav__option${
                  activeIndex === OVERVIEW_OPTION_INDEX ? " is-active" : ""
                }`}
                aria-selected={false}
                tabIndex={activeIndex === OVERVIEW_OPTION_INDEX ? 0 : -1}
                onMouseEnter={() => setActiveIndex(OVERVIEW_OPTION_INDEX)}
                onKeyDown={(e) => onOptionKeyDown(e, OVERVIEW_OPTION_INDEX)}
                onClick={() => selectOverview()}
              >
                <span className="galaxyHeaderNav__optionTitle">
                  <span className="galaxyHeaderNav__checkSpacer" aria-hidden="true" />
                  <strong>All proposals</strong>
                </span>
                <span className="galaxyHeaderNav__optionDesc">Return to Consensus Overview</span>
              </button>
            </li>
            {list.map((p, index) => {
              const optionIndex = index + 1;
              const selected = p.id === current.id;
              const optionStatus = proposalStatusLabel(p);
              return (
                <li key={p.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    data-option-index={optionIndex}
                    className={`galaxyHeaderNav__option${selected ? " is-selected" : ""}${
                      optionIndex === activeIndex ? " is-active" : ""
                    }`}
                    aria-selected={selected}
                    tabIndex={optionIndex === activeIndex ? 0 : -1}
                    onMouseEnter={() => setActiveIndex(optionIndex)}
                    onKeyDown={(e) => onOptionKeyDown(e, optionIndex)}
                    onClick={() => selectProposal(p.id)}
                    style={{
                      "--option-accent": p.visualTheme?.accent,
                      "--option-glow": p.visualTheme?.accentSoft,
                    }}
                  >
                    <span className="galaxyHeaderNav__optionTitle">
                      {selected ? (
                        <span className="galaxyHeaderNav__check" aria-hidden="true">
                          ✓
                        </span>
                      ) : (
                        <span className="galaxyHeaderNav__checkSpacer" aria-hidden="true" />
                      )}
                      <strong>{p.title}</strong>
                      {optionStatus ? (
                        <span className="galaxyHeaderNav__optionStatus">{optionStatus}</span>
                      ) : null}
                    </span>
                    <span className="galaxyHeaderNav__optionDesc">{p.description}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
