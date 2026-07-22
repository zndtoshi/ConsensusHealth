import React, { useEffect, useRef, useState } from "react";
import { fetchStanceHistoryPage } from "../api/stanceHistory";
import { buildXProfileUrl, formatFollowerLabel, normalizeXHandle } from "../utils/xProfile";
import { STANCE_COLORS, STANCE_LABELS } from "../utils/stanceColors";

type StanceKey = "against" | "neutral" | "approve";

export type TopAccount = {
  handle: string;
  followers: number;
};

export type FlowItem = {
  from: StanceKey | null;
  to: StanceKey;
  count: number;
};

export type HistoryChangeItem = {
  id: number;
  handle: string;
  display_name: string | null;
  followers_count: number | null;
  from: StanceKey | null;
  to: StanceKey;
  changed_at: string;
  changed_by: string | null;
};

export type StanceHistoryLoadStatus = "loading" | "loaded" | "error";

export type StatisticsData = {
  totalUsersWithStance: number;
  counts: Record<StanceKey, number>;
  percentages: Record<StanceKey, number>;
  totalFollowersByStance: Record<StanceKey, number>;
  avgFollowersByStance: Record<StanceKey, number>;
  topAccountByFollowers: Record<StanceKey, TopAccount | null>;
  usersChangedStanceAtLeastOnce: number;
  totalStanceChangesLast7Days: number;
  totalStanceChanges: number;
  transitionCounts: FlowItem[];
  recentChanges: HistoryChangeItem[];
  recentChangesNextCursor: string | null;
  recentChangesHasMore: boolean;
  historyStatus: StanceHistoryLoadStatus;
  historyError: string | null;
  topFlowsLast7Days: FlowItem[];
  generatedAtISO: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatInt(n: number) {
  return new Intl.NumberFormat().format(Math.round(n));
}

function formatPct(n: number) {
  const v = clamp(n, 0, 100);
  return `${v.toFixed(1)}%`;
}

function formatDateTime(iso: string) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
}

const STANCE = {
  against: { label: STANCE_LABELS.against, color: STANCE_COLORS.against },
  neutral: { label: STANCE_LABELS.neutral, color: STANCE_COLORS.neutral },
  approve: { label: STANCE_LABELS.approve, color: STANCE_COLORS.approve },
} satisfies Record<StanceKey, { label: string; color: string }>;

// Text color for stance words (dots removed; the word itself carries the color).
// Against = red, Approve = green, Neutral = white, Unset = grey.
const STANCE_TEXT_COLOR: Record<StanceKey, string> = {
  against: STANCE_COLORS.against,
  neutral: "#ffffff",
  approve: STANCE_COLORS.approve,
};
const UNSET_TEXT_COLOR = "#9ca3af";

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
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
          {title}
        </div>
        {subtitle ? (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.55)" }}>{subtitle}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0" }}>
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.62)" }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.90)", textAlign: "right" }}>
        {value}
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  borderRadius: 14,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(0,0,0,0.40)",
  padding: "4px 12px",
};

/** Shared dark inner panel used by the compact list-style cards. */
function Panel({ children }: { children: React.ReactNode }) {
  return <div style={panelStyle}>{children}</div>;
}

/** One compact row inside a Panel: left content + right value, thin separator. */
function PanelRow({
  left,
  right,
  last,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: "8px 0",
        borderBottom: last ? "none" : "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>{left}</div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 900,
          color: "rgba(255,255,255,0.96)",
          whiteSpace: "nowrap",
          flex: "0 0 auto",
        }}
      >
        {right}
      </div>
    </div>
  );
}

const overviewLabelStyle: React.CSSProperties = { fontSize: 12, color: "rgba(255,255,255,0.62)" };

function stanceWordStyle(color: string): React.CSSProperties {
  return { fontSize: 12, fontWeight: 800, color, whiteSpace: "nowrap" };
}

/** Compact flow row: "from -> to" (colored words) with its count. */
function FlowRow({ f, last }: { f: FlowItem; last?: boolean }) {
  const fromLabel = f.from ? STANCE[f.from].label : "Unset";
  const fromColor = f.from ? STANCE_TEXT_COLOR[f.from] : UNSET_TEXT_COLOR;
  return (
    <PanelRow
      last={last}
      left={
        <>
          <span style={stanceWordStyle(fromColor)}>{fromLabel}</span>
          <span style={{ opacity: 0.5 }}>→</span>
          <span style={stanceWordStyle(STANCE_TEXT_COLOR[f.to])}>{STANCE[f.to].label}</span>
        </>
      }
      right={formatInt(f.count)}
    />
  );
}

function Donut({
  size = 140,
  thickness = 16,
  centerTop,
  centerBottom,
  segments,
}: {
  size?: number;
  thickness?: number;
  centerTop: string;
  centerBottom: string;
  segments: { value: number; color: string; label: string }[];
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = Math.max(0, segments.reduce((a, s) => a + Math.max(0, s.value), 0));
  let acc = 0;

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={thickness}
        />
        {segments.map((s, idx) => {
          const v = Math.max(0, s.value);
          const frac = total === 0 ? 0 : v / total;
          const dash = frac * c;
          const gap = c - dash;
          const offset = (acc / (total || 1)) * c;
          acc += v;

          return (
            <circle
              key={idx}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ filter: "drop-shadow(0px 6px 10px rgba(0,0,0,0.35))" }}
            />
          );
        })}
      </svg>

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 900, color: "rgba(255,255,255,0.96)", lineHeight: 1.1 }}>
          {centerTop}
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.58)" }}>{centerBottom}</div>
      </div>
    </div>
  );
}

function Legend({
  items,
}: {
  items: { color: string; label: string; right: React.ReactNode }[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 800,
                color: it.color,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {it.label}
            </span>
          </div>
          <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(255,255,255,0.96)" }}>{it.right}</div>
        </div>
      ))}
    </div>
  );
}

export function StatisticsCards({
  data,
  apiBase = "",
  onRetryHistory,
}: {
  data: StatisticsData;
  apiBase?: string;
  onRetryHistory?: () => void;
}) {
  const total = data.totalUsersWithStance;
  const stanceSegments = (["against", "neutral", "approve"] as const).map((k) => ({
    value: data.counts[k],
    color: STANCE[k].color,
    label: STANCE[k].label,
  }));
  const followerTotal =
    data.totalFollowersByStance.against +
    data.totalFollowersByStance.neutral +
    data.totalFollowersByStance.approve;
  const followerSegments = (["against", "neutral", "approve"] as const).map((k) => ({
    value: data.totalFollowersByStance[k],
    color: STANCE[k].color,
    label: STANCE[k].label,
  }));
  const flowFromOrder = (from: StanceKey | null): number => {
    if (from === null) return 0; // Unset first
    if (from === "neutral") return 1;
    if (from === "against") return 2;
    if (from === "approve") return 3;
    return 4;
  };
  const sortedTopFlows = [...data.topFlowsLast7Days]
    .sort((a, b) => {
      const byFrom = flowFromOrder(a.from) - flowFromOrder(b.from);
      if (byFrom !== 0) return byFrom;
      return b.count - a.count;
    })
    // Show every distinct flow type. There are at most 9 possible (4 "from"
    // states x 3 "to" states, minus self-transitions that never occur), so
    // slicing hid rare flows and made the visible flows stop summing to the
    // "Stance changes (last 7 days)" total.
    .slice(0, 12);
  const flowsPerColumn = Math.ceil(sortedTopFlows.length / 2);
  const leftFlows = sortedTopFlows.slice(0, flowsPerColumn);
  const rightFlows = sortedTopFlows.slice(flowsPerColumn);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card title="Stance distribution" subtitle="Counts + %">
          <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", alignItems: "center", gap: 14 }}>
            <Donut size={150} thickness={16} centerTop={formatInt(total)} centerBottom="users" segments={stanceSegments} />
            <Legend
              items={(["against", "neutral", "approve"] as const).map((k) => ({
                color: STANCE_TEXT_COLOR[k],
                label: STANCE[k].label,
                right: (
                  <span>
                    {formatInt(data.counts[k])}{" "}
                    <span style={{ opacity: 0.55, fontWeight: 700 }}>({formatPct(data.percentages[k])})</span>
                  </span>
                ),
              }))}
            />
          </div>
        </Card>

        <Card title="Followers impact" subtitle="Total followers by stance">
          <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", alignItems: "center", gap: 14 }}>
            <Donut
              size={150}
              thickness={16}
              centerTop={formatInt(followerTotal)}
              centerBottom="followers"
              segments={followerSegments}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
              {(["against", "neutral", "approve"] as const).map((k) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    width: "100%",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: STANCE_TEXT_COLOR[k],
                        whiteSpace: "nowrap",
                      }}
                    >
                      {STANCE[k].label}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      width: "100%",
                      maxWidth: 132,
                      color: "rgba(255,255,255,0.96)",
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    <span style={{ marginLeft: "auto" }}>
                      {formatInt(data.totalFollowersByStance[k])}{" "}
                      <span style={{ opacity: 0.55, fontWeight: 700 }}>
                        ({formatPct(((followerTotal ? data.totalFollowersByStance[k] / followerTotal : 0) * 100))})
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 14 }}>
        <Card title="Overview" subtitle="Snapshot summary">
          <Panel>
            <PanelRow left={<span style={overviewLabelStyle}>Users with stance</span>} right={formatInt(total)} />
            <PanelRow
              left={<span style={overviewLabelStyle}>Generated</span>}
              right={<span style={{ fontWeight: 700 }}>{formatDateTime(data.generatedAtISO)}</span>}
            />
            <PanelRow
              left={<span style={overviewLabelStyle}>Changed stance (ever)</span>}
              right={formatInt(data.usersChangedStanceAtLeastOnce)}
            />
            <PanelRow
              left={<span style={overviewLabelStyle}>Stance changes (last 7 days)</span>}
              right={formatInt(data.totalStanceChangesLast7Days)}
              last
            />
          </Panel>
        </Card>

        <Card title="Average followers" subtitle="Per user in stance">
          <Panel>
            {(["against", "neutral", "approve"] as const).map((k, i) => (
              <PanelRow
                key={k}
                last={i === 2}
                left={<span style={stanceWordStyle(STANCE_TEXT_COLOR[k])}>{STANCE[k].label}</span>}
                right={formatInt(data.avgFollowersByStance[k])}
              />
            ))}
          </Panel>
        </Card>

        <Card title="Top accounts" subtitle="Highest followers per stance">
          <Panel>
            {(["against", "neutral", "approve"] as const).map((k, i) => {
              const top = data.topAccountByFollowers[k];
              return (
                <PanelRow
                  key={k}
                  last={i === 2}
                  left={
                    <>
                      <span style={stanceWordStyle(STANCE_TEXT_COLOR[k])}>{STANCE[k].label}</span>
                      <span
                        style={{
                          fontSize: 11,
                          color: "rgba(255,255,255,0.7)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          minWidth: 0,
                        }}
                      >
                        {top ? `@${top.handle}` : "—"}
                      </span>
                    </>
                  }
                  right={top ? formatInt(top.followers) : "—"}
                />
              );
            })}
          </Panel>
        </Card>
      </div>

      <Card title="Flows" subtitle="Last 7 days">
        {data.topFlowsLast7Days.length === 0 ? (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>No flows in the last 7 days.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Panel>
              {leftFlows.map((f, idx) => (
                <FlowRow key={idx} f={f} last={idx === leftFlows.length - 1} />
              ))}
            </Panel>
            <Panel>
              {rightFlows.map((f, idx) => (
                <FlowRow key={`right-${idx}`} f={f} last={idx === rightFlows.length - 1} />
              ))}
            </Panel>
          </div>
        )}
      </Card>

      <Card title="Stance history" subtitle="Persisted events">
        <div style={{ display: "grid", gap: 10, minHeight: 220 }}>
          {data.historyStatus === "loading" ? (
            <StanceHistoryLoadingSkeleton />
          ) : data.historyStatus === "error" ? (
            <div
              style={{
                borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(0,0,0,0.40)",
                padding: 12,
                display: "grid",
                gap: 10,
              }}
            >
              <div style={{ color: "#fda4af", fontSize: 12 }}>
                {data.historyError || "Unable to load stance history"}
              </div>
              {onRetryHistory ? (
                <button
                  type="button"
                  onClick={onRetryHistory}
                  aria-label="Retry loading stance history"
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
            <>
              <div
                style={{
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(0,0,0,0.40)",
                  padding: 12,
                }}
              >
                <StatRow label="Total stance changes" value={formatInt(data.totalStanceChanges)} />
                <StatRow label="Users who changed stance" value={formatInt(data.usersChangedStanceAtLeastOnce)} />
                <StatRow
                  label="Top transition"
                  value={
                    data.transitionCounts.length ? (
                      <span>
                        <span
                          style={{
                            color: data.transitionCounts[0].from
                              ? STANCE_TEXT_COLOR[data.transitionCounts[0].from]
                              : UNSET_TEXT_COLOR,
                            fontWeight: 800,
                          }}
                        >
                          {data.transitionCounts[0].from ? STANCE[data.transitionCounts[0].from].label : "Unset"}
                        </span>
                        {" -> "}
                        <span style={{ color: STANCE_TEXT_COLOR[data.transitionCounts[0].to], fontWeight: 800 }}>
                          {STANCE[data.transitionCounts[0].to].label}
                        </span>{" "}
                        ({formatInt(data.transitionCounts[0].count)})
                      </span>
                    ) : (
                      "None"
                    )
                  }
                />
              </div>
              <StanceHistoryRecentList
                apiBase={apiBase}
                initialItems={data.recentChanges}
                initialCursor={data.recentChangesNextCursor}
                initialHasMore={data.recentChangesHasMore}
                resetKey={data.generatedAtISO}
              />
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function StanceHistoryLoadingSkeleton() {
  const bar = (width: string): React.CSSProperties => ({
    height: 12,
    width,
    borderRadius: 6,
    background: "rgba(255,255,255,0.10)",
  });
  return (
    <div style={{ display: "grid", gap: 10 }} aria-busy="true" aria-live="polite">
      <div style={{ fontSize: 12, color: "rgba(255,255,255,0.70)" }}>Loading stance history…</div>
      <div
        style={{
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(0,0,0,0.40)",
          padding: 12,
          display: "grid",
          gap: 10,
          minHeight: 84,
        }}
      >
        <div style={bar("62%")} />
        <div style={bar("54%")} />
        <div style={bar("70%")} />
      </div>
      <div
        style={{
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(0,0,0,0.40)",
          padding: 12,
          display: "grid",
          gap: 10,
          minHeight: 120,
        }}
      >
        <div style={bar("40%")} />
        <div style={bar("88%")} />
        <div style={bar("80%")} />
        <div style={bar("84%")} />
      </div>
    </div>
  );
}

function StanceHandleLink({ handle }: { handle: string }) {
  const cleaned = normalizeXHandle(handle) || handle;
  const href = buildXProfileUrl(cleaned);
  const label = `@${cleaned}`;

  if (!href) {
    return <span>{label}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${label} on X`}
      style={{
        color: "inherit",
        textDecoration: "none",
        borderBottom: "1px solid rgba(255,255,255,0.22)",
        transition: "color 120ms ease, border-color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "rgba(255,255,255,1)";
        e.currentTarget.style.borderBottomColor = "rgba(255,255,255,0.55)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "inherit";
        e.currentTarget.style.borderBottomColor = "rgba(255,255,255,0.22)";
      }}
    >
      {label}
    </a>
  );
}

function StanceHistoryRecentList({
  apiBase,
  initialItems,
  initialCursor,
  initialHasMore,
  resetKey,
}: {
  apiBase: string;
  initialItems: HistoryChangeItem[];
  initialCursor: string | null;
  initialHasMore: boolean;
  resetKey: string;
}) {
  const [items, setItems] = useState<HistoryChangeItem[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor);
  const [hasMore, setHasMore] = useState(Boolean(initialHasMore));
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    setItems(initialItems);
    setNextCursor(initialCursor);
    setHasMore(Boolean(initialHasMore));
    setLoadError(null);
    loadingRef.current = false;
    setLoadingMore(false);
    // Reset only when the stats snapshot regenerates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const onLoadMore = async () => {
    if (loadingRef.current || !hasMore || !nextCursor) return;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await fetchStanceHistoryPage({
        apiBase,
        limit: 10,
        cursor: nextCursor,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((row) => row.id));
        const appended = page.items
          .filter((row) => row.id && !seen.has(row.id))
          .map((row) => ({
            id: row.id,
            handle: row.handle,
            display_name: row.display_name,
            followers_count: row.followers_count,
            from:
              row.previous_stance === "against" ||
              row.previous_stance === "neutral" ||
              row.previous_stance === "approve"
                ? row.previous_stance
                : null,
            to:
              row.new_stance === "against" ||
              row.new_stance === "neutral" ||
              row.new_stance === "approve"
                ? row.new_stance
                : ("neutral" as StanceKey),
            changed_at: row.changed_at,
            changed_by: row.changed_by,
          }))
          .filter((row) => row.to === "against" || row.to === "neutral" || row.to === "approve");
        return [...prev, ...appended];
      });
      setNextCursor(page.next_cursor);
      setHasMore(page.has_more && Boolean(page.next_cursor));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load more history.");
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  };

  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(0,0,0,0.40)",
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.96)" }}>Recent changes</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>No change events yet.</div>
      ) : (
        items.map((row, idx) => (
          <div
            key={`${row.id}-${row.changed_at}`}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "flex-start",
              flexWrap: "wrap",
              borderBottom: idx === items.length - 1 ? "none" : "1px solid rgba(255,255,255,0.06)",
              paddingBottom: 6,
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.96)",
                minWidth: 0,
                flex: "1 1 220px",
                overflowWrap: "anywhere",
              }}
            >
              <StanceHandleLink handle={row.handle} />
              <span style={{ color: "rgba(255,255,255,0.55)" }}> · </span>
              <span style={{ color: "rgba(255,255,255,0.78)" }}>{formatFollowerLabel(row.followers_count)}</span>
              <span style={{ color: "rgba(255,255,255,0.55)" }}> · </span>
              <span>
                <span style={{ color: "rgba(255,255,255,0.62)" }}>Set stance to </span>
                <span style={{ color: STANCE_TEXT_COLOR[row.to], fontWeight: 800 }}>{STANCE[row.to].label}</span>
              </span>
            </div>
            <div
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.72)",
                whiteSpace: "nowrap",
                flex: "0 0 auto",
              }}
            >
              {formatDateTime(row.changed_at)}
            </div>
          </div>
        ))
      )}

      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          aria-label={loadingMore ? "Loading more stance history" : "Load more stance history"}
          style={{
            marginTop: 4,
            borderRadius: 12,
            padding: "10px 12px",
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.25)",
            color: "rgba(255,255,255,0.88)",
            cursor: loadingMore ? "not-allowed" : "pointer",
            fontWeight: 800,
            fontSize: 12,
            opacity: loadingMore ? 0.7 : 1,
            width: "100%",
          }}
        >
          {loadingMore ? "Loading..." : "Load more"}
        </button>
      ) : null}

      {loadError ? <div style={{ color: "#fda4af", fontSize: 12 }}>{loadError}</div> : null}
    </div>
  );
}
