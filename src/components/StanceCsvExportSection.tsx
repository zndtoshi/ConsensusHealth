import React, { useState } from "react";

type StanceExportKey = "against" | "neutral" | "approve";

const EXPORT_ROUTES: Record<StanceExportKey, { path: string; label: string }> = {
  against: { path: "/api/stances/export-against.csv", label: "Download Against CSV" },
  neutral: { path: "/api/stances/export-neutral.csv", label: "Download Neutral CSV" },
  approve: { path: "/api/stances/export-approve.csv", label: "Download Approve CSV" },
};

function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(header);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const plainMatch = /filename=([^;]+)/i.exec(header);
  return plainMatch?.[1]?.trim() ?? null;
}

async function downloadStanceCsv(path: string): Promise<void> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    let message = `Download failed (${response.status})`;
    try {
      const payload = await response.json();
      if (payload?.error) message = String(payload.error);
    } catch {
      try {
        const text = (await response.text()).trim();
        if (text) message = text;
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const filename =
    parseContentDispositionFilename(response.headers.get("Content-Disposition")) ??
    path.split("/").pop() ??
    "export.csv";

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

const exportButtonStyle: React.CSSProperties = {
  borderRadius: 12,
  padding: "10px 12px",
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(0,0,0,0.25)",
  color: "rgba(255,255,255,0.88)",
  cursor: "pointer",
  fontWeight: 800,
  fontSize: 12,
  width: "100%",
};

export function StanceCsvExportSection() {
  const [downloading, setDownloading] = useState<StanceExportKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDownload = async (stance: StanceExportKey) => {
    setError(null);
    setDownloading(stance);
    try {
      await downloadStanceCsv(EXPORT_ROUTES[stance].path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div
      style={{
        borderRadius: 18,
        border: "1px solid rgba(255,255,255,0.10)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.06) 100%)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        padding: 16,
        backdropFilter: "blur(10px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2, color: "rgba(255,255,255,0.96)" }}>
          Export data
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>
          Download account lists grouped by stance.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
        }}
      >
        {(Object.keys(EXPORT_ROUTES) as StanceExportKey[]).map((stance) => {
          const isDownloading = downloading === stance;
          return (
            <button
              key={stance}
              type="button"
              disabled={isDownloading}
              onClick={() => onDownload(stance)}
              style={{
                ...exportButtonStyle,
                opacity: isDownloading ? 0.7 : 1,
                cursor: isDownloading ? "not-allowed" : "pointer",
              }}
            >
              {isDownloading ? "Downloading..." : EXPORT_ROUTES[stance].label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div style={{ marginTop: 10, color: "#fda4af", fontSize: 12 }}>{error}</div>
      ) : null}
    </div>
  );
}
