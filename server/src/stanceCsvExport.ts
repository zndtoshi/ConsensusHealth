import { normalizeStanceValue, type StanceValue } from "./stanceHistory.js";

export type StanceCsvRow = {
  handle: string;
  display_name: string;
  /** Internal only — used for sort/dedup, never written to CSV. */
  followers_count: number;
};

const CSV_COLUMNS = ["handle", "display_name"] as const;

export function normalizeHandleForExport(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function toDisplayName(value: unknown): string {
  return String(value ?? "").trim();
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
    display_name: toDisplayName(row.name),
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

export function escapeCsvValue(raw: unknown): string {
  let value = raw == null ? "" : String(raw);
  const originalStartsWithFormulaChar = /^[=+\-@]/.test(value);
  if (originalStartsWithFormulaChar) {
    value = `'${value}`;
  }
  const needsQuotes =
    originalStartsWithFormulaChar ||
    /[",\r\n]/.test(value) ||
    value.includes("'");

  if (needsQuotes) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildStanceCsvContent(rows: StanceCsvRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push([escapeCsvValue(row.handle), escapeCsvValue(row.display_name)].join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
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
