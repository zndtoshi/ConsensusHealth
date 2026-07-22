/** Tooltip / profile line: "X join date: October 2011" */
export function formatXJoinDate(accountCreatedAt: unknown): string {
  if (!accountCreatedAt) return "";
  const created = new Date(String(accountCreatedAt));
  if (!Number.isFinite(created.getTime())) return "";
  const label = created.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `X join date: ${label}`;
}
