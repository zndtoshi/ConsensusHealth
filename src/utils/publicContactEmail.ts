const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Public contact only when a valid email is configured — never show deploy instructions. */
export function resolvePublicContactEmail(contactEmail?: string | null): string {
  const fromProp = String(contactEmail || "").trim();
  if (EMAIL_RE.test(fromProp)) return fromProp;
  try {
    const fromEnv = String(
      (typeof import.meta !== "undefined" && (import.meta as { env?: { VITE_CONTACT_EMAIL?: string } }).env
        ?.VITE_CONTACT_EMAIL) ||
        ""
    ).trim();
    if (EMAIL_RE.test(fromEnv)) return fromEnv;
  } catch {
    /* ignore */
  }
  return "";
}
