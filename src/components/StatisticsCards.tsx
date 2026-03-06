import React from "react";

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

export type StatisticsData = {
  totalUsersWithStance: number;
  counts: Record<StanceKey, number>;
  percentages: Record<StanceKey, number>;
  totalFollowersByStance: Record<StanceKey, number>;
  avgFollowersByStance: Record<StanceKey, number>;
  topAccountByFollowers: Record<StanceKey, TopAccount | null>;
  usersChangedStanceAtLeastOnce: number;
  totalStanceChangesLast7Days: number;
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
  against: { label: "Against", color: "#ef4444" },
  neutral: { label: "Neutral", color: "#9ca3af" },
  approve: { label: "Approve", color: "#22c55e" },
} satisfies Record<StanceKey, { label: string; color: string }>;

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
                width: 10,
                height: 10,
                borderRadius: 999,
                background: it.color,
                boxShadow: "0 0 0 3px rgba(255,255,255,0.06), 0 10px 20px rgba(0,0,0,0.30)",
              }}
            />
            <span
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.85)",
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

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        borderRadius: 999,
        padding: "6px 10px",
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(0,0,0,0.22)",
        color: "rgba(255,255,255,0.82)",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {children}
    </span>
  );
}

export function StatisticsCards({ data }: { data: StatisticsData }) {
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

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
        <Card title="Overview" subtitle="Snapshot summary">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
            <Pill>
              <span style={{ opacity: 0.7 }}>Users with stance</span>
              <span style={{ fontWeight: 900 }}>{formatInt(total)}</span>
            </Pill>
            <Pill>
              <span style={{ opacity: 0.7 }}>Generated</span>
              <span style={{ fontWeight: 900 }}>{formatDateTime(data.generatedAtISO)}</span>
            </Pill>
          </div>

          <div
            style={{
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(0,0,0,0.40)",
              padding: 12,
            }}
          >
            <StatRow label="Changed stance (ever)" value={formatInt(data.usersChangedStanceAtLeastOnce)} />
            <StatRow label="Stance changes (last 7 days)" value={formatInt(data.totalStanceChangesLast7Days)} />
            <StatRow
              label="Top flows (last 7 days)"
              value={data.topFlowsLast7Days.length ? formatInt(data.topFlowsLast7Days.length) : "None"}
            />
          </div>
        </Card>

        <Card title="Stance distribution" subtitle="Counts + %">
          <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", alignItems: "center", gap: 14 }}>
            <Donut size={150} thickness={16} centerTop={formatInt(total)} centerBottom="users" segments={stanceSegments} />
            <Legend
              items={(["against", "neutral", "approve"] as const).map((k) => ({
                color: STANCE[k].color,
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
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
        <Card title="Followers impact" subtitle="Total followers by stance">
          <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", alignItems: "center", gap: 14 }}>
            <Donut
              size={150}
              thickness={16}
              centerTop={formatInt(followerTotal)}
              centerBottom="followers"
              segments={followerSegments}
            />
            <Legend
              items={(["against", "neutral", "approve"] as const).map((k) => ({
                color: STANCE[k].color,
                label: STANCE[k].label,
                right: formatInt(data.totalFollowersByStance[k]),
              }))}
            />
          </div>
        </Card>

        <Card title="Average followers" subtitle="Per user in stance">
          <div
            style={{
              borderRadius: 14,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(0,0,0,0.40)",
              padding: 12,
            }}
          >
            {(["against", "neutral", "approve"] as const).map((k) => (
              <div
                key={k}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: k === "approve" ? "none" : "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: STANCE[k].color }} />
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", fontWeight: 800 }}>
                    {STANCE[k].label}
                  </span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.96)" }}>
                  {formatInt(data.avgFollowersByStance[k])}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Top accounts" subtitle="Highest followers per stance">
          <div style={{ display: "grid", gap: 10 }}>
            {(["against", "neutral", "approve"] as const).map((k) => {
              const top = data.topAccountByFollowers[k];
              return (
                <div
                  key={k}
                  style={{
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(0,0,0,0.40)",
                    padding: 12,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: STANCE[k].color }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.96)" }}>{STANCE[k].label}</div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "rgba(255,255,255,0.85)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: 210,
                        }}
                      >
                        {top ? `@${top.handle}` : "—"}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.96)" }}>
                    {top ? formatInt(top.followers) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card title="Flows" subtitle="Last 7 days">
        {data.topFlowsLast7Days.length === 0 ? (
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)" }}>No flows in the last 7 days.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {data.topFlowsLast7Days.slice(0, 8).map((f, idx) => {
              const fromLabel = f.from ? STANCE[f.from].label : "Unset";
              const fromColor = f.from ? STANCE[f.from].color : "rgba(255,255,255,0.45)";
              const to = STANCE[f.to];
              return (
                <div
                  key={idx}
                  style={{
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(0,0,0,0.40)",
                    padding: 12,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: fromColor }} />
                    <span style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.96)" }}>{fromLabel}</span>
                    <span style={{ opacity: 0.5 }}>→</span>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: to.color }} />
                    <span style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.96)" }}>{to.label}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.96)" }}>{formatInt(f.count)}</div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
