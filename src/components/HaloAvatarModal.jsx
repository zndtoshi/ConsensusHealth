import React, { useEffect, useMemo, useRef, useState } from "react";
import { STANCE_LABELS } from "../utils/stanceColors";
import {
  assertHaloAvatarAdmin,
  haloAvatarFilename,
  haloColorForStance,
  isHaloAvatarAdmin,
  normalizeHaloStance,
} from "../utils/haloAvatarAdmin";
import {
  HALO_AVATAR_OUTPUT_SIZE,
  loadHaloAvatarImage,
  renderHaloAvatarPngBlob,
  triggerHaloAvatarDownload,
} from "../utils/haloAvatarCanvas";

/**
 * Compact admin-only modal: preview + download a stance-halo PNG of the
 * current consensus.health avatar. Canvas work starts only after open.
 */
export function HaloAvatarModal({
  open,
  onClose,
  user,
  avatarSrc,
  stance,
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revokePreviewRef = useRef(null);
  const revokeDownloadRef = useRef(null);

  const stanceKey = useMemo(() => normalizeHaloStance(stance), [stance]);
  const haloColor = useMemo(() => haloColorForStance(stanceKey), [stanceKey]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    async function buildPreview() {
      setError("");
      setBusy(true);
      try {
        assertHaloAvatarAdmin(user);
        if (!avatarSrc) throw new Error("No avatar URL is available for export.");
        const img = await loadHaloAvatarImage(avatarSrc);
        if (cancelled) return;
        const blob = await renderHaloAvatarPngBlob({
          image: img,
          stanceColor: haloColor,
          size: HALO_AVATAR_OUTPUT_SIZE,
        });
        if (cancelled) return;
        if (revokePreviewRef.current) revokePreviewRef.current();
        const url = URL.createObjectURL(blob);
        revokePreviewRef.current = () => URL.revokeObjectURL(url);
        setPreviewUrl(url);
      } catch (err) {
        if (!cancelled) {
          setPreviewUrl("");
          setError(err?.message || "Unable to prepare halo avatar preview.");
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    buildPreview();
    return () => {
      cancelled = true;
    };
  }, [open, user, avatarSrc, haloColor]);

  useEffect(() => {
    if (open) return undefined;
    if (revokePreviewRef.current) {
      revokePreviewRef.current();
      revokePreviewRef.current = null;
    }
    if (revokeDownloadRef.current) {
      revokeDownloadRef.current();
      revokeDownloadRef.current = null;
    }
    setPreviewUrl("");
    setError("");
    setBusy(false);
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (!isHaloAvatarAdmin(user)) return null;

  async function onDownload() {
    setError("");
    setBusy(true);
    try {
      assertHaloAvatarAdmin(user);
      if (!avatarSrc) throw new Error("No avatar URL is available for export.");
      const img = await loadHaloAvatarImage(avatarSrc);
      const blob = await renderHaloAvatarPngBlob({
        image: img,
        stanceColor: haloColor,
        size: HALO_AVATAR_OUTPUT_SIZE,
      });
      if (revokeDownloadRef.current) revokeDownloadRef.current();
      const cleanup = triggerHaloAvatarDownload(blob, haloAvatarFilename(stanceKey));
      revokeDownloadRef.current = cleanup;
      window.setTimeout(() => {
        if (revokeDownloadRef.current === cleanup) {
          cleanup();
          revokeDownloadRef.current = null;
        }
      }, 60_000);
    } catch (err) {
      setError(err?.message || "Unable to download halo avatar PNG.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={styles.backdrop}
      onClick={() => onClose?.()}
      role="presentation"
    >
      <div
        style={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label="Download Halo Avatar"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.headerRow}>
          <div>
            <div style={styles.title}>Download Halo Avatar</div>
            <div style={styles.subtitle}>
              {STANCE_LABELS[stanceKey]} halo · {HALO_AVATAR_OUTPUT_SIZE}×{HALO_AVATAR_OUTPUT_SIZE} PNG
            </div>
          </div>
          <button type="button" className="toolbarBtn" onClick={() => onClose?.()} aria-label="Close">
            Close
          </button>
        </div>

        <div style={styles.previewWrap}>
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Halo avatar preview"
              style={styles.previewImg}
            />
          ) : (
            <div style={styles.previewPlaceholder}>
              {busy ? "Preparing preview…" : "Preview unavailable"}
            </div>
          )}
        </div>

        <div style={styles.metaRow}>
          <span style={{ ...styles.swatch, background: haloColor }} aria-hidden="true" />
          <span style={styles.metaText}>Stance color: {STANCE_LABELS[stanceKey]}</span>
        </div>

        {error ? (
          <div style={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        <div style={styles.actions}>
          <button
            type="button"
            className="toolbarBtn toolbarBtn--primary"
            onClick={onDownload}
            disabled={busy || !previewUrl}
          >
            {busy ? "Working…" : "Download PNG"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 240,
    background: "rgba(2, 6, 23, 0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "min(420px, 100%)",
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(15,23,42,0.96)",
    boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
    padding: 16,
    display: "grid",
    gap: 14,
  },
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    fontWeight: 800,
    fontSize: 15,
    color: "#f8fafc",
  },
  subtitle: {
    marginTop: 4,
    fontSize: 12,
    color: "rgba(226,232,240,0.72)",
  },
  previewWrap: {
    display: "flex",
    justifyContent: "center",
    padding: "8px 0",
  },
  previewImg: {
    width: 220,
    height: 220,
    // Square PNG already includes the circular crop + halo; do not add a
    // second CSS ring outside the avatar.
    objectFit: "contain",
    background: "transparent",
  },
  previewPlaceholder: {
    width: 220,
    height: 220,
    borderRadius: "50%",
    border: "1px dashed rgba(255,255,255,0.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "rgba(226,232,240,0.7)",
    fontSize: 12,
    textAlign: "center",
    padding: 16,
  },
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 999,
    boxShadow: "0 0 0 1px rgba(255,255,255,0.2)",
  },
  metaText: {
    fontSize: 12,
    color: "rgba(226,232,240,0.82)",
    fontWeight: 700,
  },
  error: {
    borderRadius: 10,
    border: "1px solid rgba(251,113,133,0.35)",
    background: "rgba(127,29,29,0.35)",
    color: "#fecdd3",
    fontSize: 12,
    padding: "10px 12px",
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
  },
};
