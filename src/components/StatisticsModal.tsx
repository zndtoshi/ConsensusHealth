import React, { useEffect } from "react";
import { StatisticsCards, type StatisticsData } from "./StatisticsCards";

export function StatisticsModal({
  open,
  onClose,
  data,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  data: StatisticsData | null;
  loading?: boolean;
  error?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.55)",
      }}
      onMouseDown={(e) => {
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
            "radial-gradient(1200px 600px at 20% 0%, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 55%, rgba(0,0,0,0.35) 100%)",
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
            <div style={{ fontSize: 18, fontWeight: 900, color: "rgba(255,255,255,0.95)" }}>Statistics</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.60)" }}>Structured snapshot with charts</div>
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

        {loading ? (
          <div style={{ opacity: 0.85, fontSize: 13 }}>Loading statistics...</div>
        ) : error ? (
          <div style={{ color: "#fda4af", fontSize: 13 }}>{error}</div>
        ) : data ? (
          <StatisticsCards data={data} />
        ) : (
          <div style={{ opacity: 0.85, fontSize: 13 }}>No statistics available.</div>
        )}
      </div>
    </div>
  );
}
