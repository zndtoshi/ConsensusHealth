import { normalizeStanceValue, type StanceValue } from "./stanceHistory.js";

export type StanceCsvRow = {
  handle: string;
  display_name: string;
  followers_count: number;
  profile_url: string;
  avatar_url: string;
  updated_at: string;
};

const CSV_COLUMNS = [
  "handle",
  "display_name",
  "followers_count",
  "profile_url",
  "avatar_url",
  "updated_at",
] as const;

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

function toAvatarUrl(row: Record<string, unknown>): string {
  const raw =
    row.avatar_url ??
    row.avatarUrl ??
    row.profile_image_url ??
    row.profileImageUrl;
  return typeof raw === "string" ? raw.trim() : "";
}

function toUpdatedAt(row: Record<string, unknown>): string {
  const raw = row.updated_at ?? row.updatedAt;
  if (raw == null || raw === "") return "";
  if (raw instanceof Date) return raw.toISOString();
  const text = String(raw).trim();
  if (!text) return "";
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
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
    profile_url: `https://x.com/${handle}`,
    avatar_url: toAvatarUrl(row),
    updated_at: toUpdatedAt(row),
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
      continue;
    }
    if (row.followers_count === existing.followers_count && row.updated_at > existing.updated_at) {
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
    lines.push(
      [
        escapeCsvValue(row.handle),
        escapeCsvValue(row.display_name),
        escapeCsvValue(row.followers_count),
        escapeCsvValue(row.profile_url),
        escapeCsvValue(row.avatar_url),
        escapeCsvValue(row.updated_at),
      ].join(",")
    );
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
