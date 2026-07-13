import { normalizeStanceValue, type StanceValue } from "./stanceHistory.js";

export type StanceCsvRow = {
  handle: string;
  display_name: string;
  /** Internal only — used for sort/dedup, never written to CSV. */
  followers_count: number;
};

export function normalizeHandleForExport(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function toFollowersCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

export function mapCommunityRowToCsvExport(row: Record<string, unknown>): StanceCsvRow | null {
  const handle = normalizeHandleForExport(row.handle ?? row.username ?? row.screen_name);
  if (!handle) return null;

  const stance = normalizeStanceValue(row.stance);
  if (!stance) return null;

  return {
    handle,
    display_name: String(row.name ?? ""),
    followers_count: toFollowersCount(row.followers_count),
  };
}

export function deduplicateCsvRowsByHandle(rows: StanceCsvRow[]): StanceCsvRow[] {
  const byHandle = new Map<string, StanceCsvRow>();

  for (const row of rows) {
    const key = row.handle.toLowerCase();
    const existing = byHandle.get(key);
    if (!existing) {
      byHandle.set(key, row);
      continue;
    }
    if (row.followers_count > existing.followers_count) {
      byHandle.set(key, row);
    }
  }

  return Array.from(byHandle.values());
}

export function sortCsvRows(rows: StanceCsvRow[]): StanceCsvRow[] {
  return [...rows].sort((a, b) => {
    if (b.followers_count !== a.followers_count) {
      return b.followers_count - a.followers_count;
    }
    return a.handle.localeCompare(b.handle);
  });
}

export function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildStanceCsvRows(rows: StanceCsvRow[]): string[][] {
  return [
    ["handle", "display_name"],
    ...rows.map((row) => [row.handle, row.display_name]),
  ];
}

export function serializeStanceCsv(rows: string[][]): string {
  return "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

export function buildStanceCsvContent(rows: StanceCsvRow[]): string {
  return serializeStanceCsv(buildStanceCsvRows(rows));
}

export function buildStanceCsvFilename(stance: StanceValue, date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `consensus-health-${stance}-${yyyy}-${mm}-${dd}.csv`;
}

export function buildStanceCsvExport(
  mergedRows: Record<string, unknown>[],
  stance: StanceValue
): { filename: string; content: string } {
  const mapped = mergedRows
    .filter((row) => normalizeStanceValue(row.stance) === stance)
    .map(mapCommunityRowToCsvExport)
    .filter((row): row is StanceCsvRow => row !== null);

  const deduped = deduplicateCsvRowsByHandle(mapped);
  const sorted = sortCsvRows(deduped);

  return {
    filename: buildStanceCsvFilename(stance),
    content: buildStanceCsvContent(sorted),
  };
}
