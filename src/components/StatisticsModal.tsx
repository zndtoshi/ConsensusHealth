import React, { useEffect } from "react";
import { StatisticsCards, type StatisticsData } from "./StatisticsCards";
import { StanceCsvExportSection } from "./StanceCsvExportSection";

export function StatisticsModal({
  open,
  onClose,
  data,
  loading,
  error,
  apiBase = "",
  proposalId = "bip110",
  heading = "Statistics",
  subtitle = "Current positions",
  onOpenInfoPage,
  onRetryHistory,
  escapeEnabled = true,
  inertWhileCovered = false,
}: {
  open: boolean;
  onClose: () => void;
  data: StatisticsData | null;
  loading?: boolean;
  error?: string;
  apiBase?: string;
  proposalId?: string;
  heading?: string;
  subtitle?: string;
  onOpenInfoPage?: (page: "privacy" | "terms" | "how-it-works") => void;
  onRetryHistory?: () => void;
  /** When false (e.g. Privacy/Terms overlay open), Escape must not close Statistics. */
  escapeEnabled?: boolean;
  /** Hide from AT when a higher overlay owns focus. */
  inertWhileCovered?: boolean;
}) {
  useEffect(() => {
    if (!open || !escapeEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, escapeEnabled]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal={inertWhileCovered ? undefined : true}
      aria-hidden={inertWhileCovered ? true : undefined}
      inert={inertWhileCovered ? true : undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.55)",
      }}
      onMouseDown={(e) => {
        if (inertWhileCovered) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(980px, calc(100vw - 28px))",
          maxHeight: "min(82vh, 760px)",
          overflow: "auto",
          borderRadius: 22,
          border: "1px solid rgba(255,255,255,0.12)",
          background:
            "radial-gradient(1200px 600px at 20% 0%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.06) 55%, rgba(0,0,0,0.60) 100%)",
          boxShadow: "0 20px 70px rgba(0,0,0,0.55)",
          padding: 18,
          backdropFilter: "blur(12px)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: "rgba(255,255,255,0.95)" }}>{heading}</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.60)" }}>{subtitle}</div>
          </div>

          <button
            onClick={onClose}
            style={{
              borderRadius: 12,
              padding: "10px 12px",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(0,0,0,0.25)",
              color: "rgba(255,255,255,0.88)",
              cursor: "pointer",
              fontWeight: 800,
              fontSize: 12,
            }}
          >
            Close
          </button>
        </div>

        {data ? (
          <StatisticsCards data={data} apiBase={apiBase} proposalId={proposalId} onRetryHistory={onRetryHistory} />
        ) : loading ? (
          <div style={{ opacity: 0.85, fontSize: 13 }}>Loading statistics...</div>
        ) : error ? (
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ color: "#fda4af", fontSize: 13 }}>{error}</div>
            {onRetryHistory ? (
              <button
                type="button"
                onClick={onRetryHistory}
                style={{
                  borderRadius: 12,
                  padding: "10px 12px",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(0,0,0,0.25)",
                  color: "rgba(255,255,255,0.88)",
                  cursor: "pointer",
                  fontWeight: 800,
                  fontSize: 12,
                  width: "fit-content",
                }}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : (
          <div style={{ opacity: 0.85, fontSize: 13 }}>No statistics available.</div>
        )}

        <div style={{ marginTop: 16 }}>
          <StanceCsvExportSection proposalId={proposalId} />
        </div>

        {onOpenInfoPage ? (
          <nav className="legalFooterLinks statisticsModal__infoLinks" aria-label="Site information">
            <button type="button" onClick={() => onOpenInfoPage("privacy")}>
              Privacy
            </button>
            <button type="button" onClick={() => onOpenInfoPage("terms")}>
              Terms
            </button>
            <button type="button" onClick={() => onOpenInfoPage("how-it-works")}>
              How it works
            </button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
