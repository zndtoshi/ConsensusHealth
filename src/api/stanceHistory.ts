import {
  buildXProfileUrl,
  formatFollowerLabel,
  normalizeXHandle,
} from "../utils/xProfile";

export type StanceHistoryPageItem = {
  id: number;
  handle: string;
  display_name: string | null;
  followers_count: number | null;
  previous_stance: string | null;
  new_stance: string;
  changed_at: string;
  changed_by: string | null;
};

export type StanceHistoryPage = {
  items: StanceHistoryPageItem[];
  next_cursor: string | null;
  has_more: boolean;
};

function toNullableInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

export async function fetchStanceHistoryPage(args: {
  apiBase?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<StanceHistoryPage> {
  const base = (args.apiBase || "").replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("limit", String(args.limit ?? 10));
  if (args.cursor) params.set("cursor", args.cursor);

  const res = await fetch(`${base}/api/stance-history?${params.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to load stance history (${res.status})`);
  }
  const data = await res.json();
  const itemsRaw = Array.isArray(data?.items) ? data.items : [];
  const items: StanceHistoryPageItem[] = itemsRaw.map((r: Record<string, unknown>) => ({
    id: Number(r.id) || 0,
    handle: normalizeXHandle(r.handle) || "(unknown)",
    display_name: r.display_name != null && String(r.display_name).trim() ? String(r.display_name) : null,
    followers_count: toNullableInt(r.followers_count),
    previous_stance: r.previous_stance == null ? null : String(r.previous_stance),
    new_stance: String(r.new_stance ?? ""),
    changed_at: String(r.changed_at || ""),
    changed_by: r.changed_by != null && String(r.changed_by).trim() ? String(r.changed_by) : null,
  }));

  return {
    items,
    next_cursor: data?.next_cursor ? String(data.next_cursor) : null,
    has_more: Boolean(data?.has_more),
  };
}

export { buildXProfileUrl, formatFollowerLabel, normalizeXHandle };
