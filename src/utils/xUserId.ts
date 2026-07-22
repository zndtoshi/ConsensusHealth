/** Client-side X user ID helpers — keep IDs as opaque digit strings. */

export function coerceXUserIdToDigitString(value: unknown): string | null {
  if (typeof value === "bigint") {
    const s = value.toString();
    return /^\d+$/.test(s) ? s : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    return /^\d+$/.test(s) ? s : null;
  }
  return null;
}

export function coerceXUserIdKey(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const s = value.trim();
    return s || null;
  }
  return null;
}

export function quoteSnowflakeIdFieldsInJsonText(text: string): string {
  return text.replace(
    /("(?:id|x_user_id|xUserId|userId|user_id)"\s*:\s*)(-?\d{15,})(\s*[,}\]])/g,
    '$1"$2"$3'
  );
}

export function parseJsonPreservingSnowflakeIds(text: string): unknown {
  return JSON.parse(quoteSnowflakeIdFieldsInJsonText(text));
}
