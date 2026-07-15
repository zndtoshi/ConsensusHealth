export type NewStanceEvent = {
  eventId: number;
  xUserId: string;
  handle: string;
  displayName: string | null;
  stance: "against" | "neutral" | "approve";
  createdAt: string;
  avatarPath: string | null;
  hasAvatarBlob: boolean;
};

export async function fetchNewStanceEvents(opts: {
  afterEventId?: number | null;
  limit?: number;
}): Promise<NewStanceEvent[]> {
  const base = ((import.meta as any).env?.VITE_API_BASE || "").replace(/\/$/, "");
  const params = new URLSearchParams();
  if (opts.afterEventId != null && Number.isFinite(opts.afterEventId) && opts.afterEventId > 0) {
    params.set("afterEventId", String(Math.trunc(opts.afterEventId)));
  }
  if (opts.limit != null) params.set("limit", String(Math.trunc(opts.limit)));
  const qs = params.toString();
  const url = `${base}/api/stances/new${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`fetch_new_stances_failed:${res.status}`);
  const data = (await res.json()) as { items?: NewStanceEvent[] };
  return Array.isArray(data.items) ? data.items : [];
}
