import { normalizeXHandle } from "../utils/xProfile";

export type AvatarStanceHistoryEvent = {
  id: number;
  previous_stance: string | null;
  new_stance: string;
  changed_at: string;
  changed_by: string | null;
};

export type AvatarStanceHistoryResponse = {
  history: AvatarStanceHistoryEvent[];
};

export function provenanceLabel(changedBy: string | null | undefined): "Curated" | "Self-reported" {
  return String(changedBy || "").trim().toLowerCase() === "user" ? "Self-reported" : "Curated";
}

export async function fetchAvatarStanceHistory(args: {
  apiBase?: string;
  handle?: string | null;
  xUserId?: string | null;
  signal?: AbortSignal;
}): Promise<AvatarStanceHistoryEvent[]> {
  const base = (args.apiBase || "").replace(/\/$/, "");
  const params = new URLSearchParams();
  const xUserId = String(args.xUserId || "").trim();
  const handle = normalizeXHandle(args.handle);
  if (xUserId) params.set("x_user_id", xUserId);
  if (handle) params.set("handle", handle);
  if (![...params.keys()].length) return [];

  const res = await fetch(`${base}/api/stance-history?${params.toString()}`, {
    credentials: "include",
    signal: args.signal,
  });
  if (!res.ok) throw new Error(`Failed to load avatar stance history (${res.status})`);
  const data = (await res.json()) as AvatarStanceHistoryResponse;
  const rows = Array.isArray(data?.history) ? data.history : [];
  return rows.map((r) => ({
    id: Number(r.id) || 0,
    previous_stance: r.previous_stance == null ? null : String(r.previous_stance),
    new_stance: String(r.new_stance ?? ""),
    changed_at: String(r.changed_at || ""),
    changed_by: r.changed_by != null ? String(r.changed_by) : null,
  }));
}
