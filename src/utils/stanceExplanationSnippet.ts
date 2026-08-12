/** Truncate verified tweet text for hover tooltips (plain text only). */
export function snippetStanceExplanation(text, maxChars = 160) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}
