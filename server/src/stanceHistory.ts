export type StanceValue = "against" | "neutral" | "approve";
export type ChangedByValue = "user" | "admin" | "system" | "oauth" | "backfill";

export type HistoryEvent = {
  x_user_id: string;
  previous_stance: StanceValue | null;
  new_stance: StanceValue;
  changed_at: string;
  changed_by: ChangedByValue | null;
};

export function normalizeStanceValue(value: unknown): StanceValue | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "support") return "approve";
  if (v === "against" || v === "neutral" || v === "approve") return v;
  return null;
}

export function shouldRecordStanceChange(previous: StanceValue | null, next: StanceValue): boolean {
  return previous !== next;
}

export function createHistoryEvent(input: {
  x_user_id: string;
  previous_stance: StanceValue | null;
  new_stance: StanceValue;
  changed_by?: ChangedByValue | null;
  changed_at?: string;
}): HistoryEvent | null {
  if (!shouldRecordStanceChange(input.previous_stance, input.new_stance)) return null;
  return {
    x_user_id: String(input.x_user_id || "").trim(),
    previous_stance: input.previous_stance,
    new_stance: input.new_stance,
    changed_at: input.changed_at || new Date().toISOString(),
    changed_by: input.changed_by ?? null,
  };
}

export function shouldBackfillInitialHistory(params: {
  hasHistory: boolean;
  currentStance: StanceValue | null;
}): boolean {
  return !params.hasHistory && params.currentStance !== null;
}

export function sortHistoryByChangedAtAsc<T extends { changed_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => new Date(a.changed_at).getTime() - new Date(b.changed_at).getTime());
}

export function summarizeHistory(rows: HistoryEvent[]): {
  totalChanges: number;
  changedUsers: number;
  transitionCounts: Record<string, number>;
} {
  const totalChanges = rows.length;
  const changedUsersSet = new Set(rows.map((r) => r.x_user_id));
  const transitionCounts: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.previous_stance ?? "unset"}->${r.new_stance}`;
    transitionCounts[key] = (transitionCounts[key] || 0) + 1;
  }
  return {
    totalChanges,
    changedUsers: changedUsersSet.size,
    transitionCounts,
  };
}
