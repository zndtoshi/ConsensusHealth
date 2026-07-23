import React from "react";

function IconPlay({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M8 5v14l11-7L8 5z" />
    </svg>
  );
}

function IconPause({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
    </svg>
  );
}

function IconStop({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M6 6h12v12H6V6z" />
    </svg>
  );
}

function IconRewind({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M11 18V6l-8.5 6L11 18zm.5-6 8.5 6V6l-8.5 6z" />
    </svg>
  );
}

/**
 * Compact transport card above the bottom toolbar for admin history playback.
 */
export function AdminHistoryTransport({
  open,
  playing,
  paused,
  onPlay,
  onPause,
  onStop,
  onRewind,
}) {
  if (!open) return null;

  const showTransport = playing || paused;

  return (
    <div className="adminHistoryTransport" role="group" aria-label="History playback controls">
      {!showTransport ? (
        <button
          type="button"
          className="adminHistoryTransport__btn"
          onClick={onPlay}
          title="Play history"
          aria-label="Play history"
        >
          <IconPlay />
          <span>Play</span>
        </button>
      ) : (
        <>
          <button
            type="button"
            className="adminHistoryTransport__btn"
            onClick={onRewind}
            title="Rewind"
            aria-label="Rewind history"
          >
            <IconRewind />
          </button>
          {paused ? (
            <button
              type="button"
              className="adminHistoryTransport__btn adminHistoryTransport__btn--primary"
              onClick={onPlay}
              title="Resume"
              aria-label="Resume history"
            >
              <IconPlay />
            </button>
          ) : (
            <button
              type="button"
              className="adminHistoryTransport__btn adminHistoryTransport__btn--primary"
              onClick={onPause}
              title="Pause"
              aria-label="Pause history"
            >
              <IconPause />
            </button>
          )}
          <button
            type="button"
            className="adminHistoryTransport__btn"
            onClick={onStop}
            title="Stop"
            aria-label="Stop history"
          >
            <IconStop />
          </button>
        </>
      )}
    </div>
  );
}
