/**
 * Production env validation for public launch.
 * Fails fast in production on missing/weak secrets and misconfigured URLs.
 * Development may warn for softer cases without exiting.
 */

export type EnvLike = Record<string, string | undefined>;

export type AssertProductionEnvOptions = {
  /** When true, throw instead of process.exit (for tests). Default false. */
  throwOnFatal?: boolean;
  /** Logger for warnings. Defaults to console.warn. */
  warn?: (message: string) => void;
  /** Logger for fatal errors. Defaults to console.error. */
  error?: (message: string) => void;
  /** Override exit. Defaults to process.exit. */
  exit?: (code: number) => never;
};

const PLACEHOLDER_SECRETS = new Set([
  "",
  "change_me",
  "change_me_long_random",
  "changeme",
  "secret",
  "password",
  "your_session_secret",
  "replace_me",
]);

const MIN_SESSION_SECRET_LEN = 32;

export function isValidPublicContactEmail(value: unknown): boolean {
  const email = String(value ?? "").trim();
  if (!email || email.length > 254) return false;
  // Practical public-contact check (not full RFC).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function resolveContactEmail(env: EnvLike = process.env): string | null {
  const contact = String(env.CONTACT_EMAIL || "").trim();
  if (contact) return isValidPublicContactEmail(contact) ? contact : null;
  const privacy = String(env.PRIVACY_CONTACT_EMAIL || "").trim();
  if (privacy) return isValidPublicContactEmail(privacy) ? privacy : null;
  return null;
}

/**
 * Live CONTACT_EMAIL (or PRIVACY_CONTACT_EMAIL) from process.env.
 * Call after dotenv.config() — do not cache at module load (ESM imports hoist).
 */
export function getContactEmail(): string | null {
  return resolveContactEmail(process.env);
}

/** @deprecated Use getContactEmail() after dotenv; kept as a named export alias. */
export const CONTACT_EMAIL = {
  get value(): string | null {
    return getContactEmail();
  },
};

function isPlaceholderSecret(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (PLACEHOLDER_SECRETS.has(v)) return true;
  if (v.includes("change_me") || v.includes("replace_me") || v.includes("your_")) return true;
  return false;
}

function isValidHttpsOriginOrUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:") return false;
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

function oauthClientId(env: EnvLike): string {
  return String(env.X_CLIENT_ID || env.TWITTER_CLIENT_ID || "").trim();
}

function oauthClientSecret(env: EnvLike): string {
  return String(env.X_CLIENT_SECRET || env.TWITTER_CLIENT_SECRET || "").trim();
}

export type EnvValidationResult = {
  ok: boolean;
  fatal: string[];
  warnings: string[];
};

/**
 * Validate env for the given mode. Does not exit/throw by itself —
 * use assertProductionEnv for startup gating.
 */
export function validateEnv(env: EnvLike, opts: { isProd: boolean }): EnvValidationResult {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const sessionSecret = String(env.SESSION_SECRET || "");
  const databaseUrl = String(env.DATABASE_URL || "").trim();
  const appOrigin = String(env.APP_ORIGIN || "").trim();
  const appUrl = String(env.APP_URL || "").trim();
  const clientId = oauthClientId(env);
  const clientSecret = oauthClientSecret(env);

  if (!sessionSecret.trim()) {
    const msg = "SESSION_SECRET is missing";
    if (opts.isProd) fatal.push(msg);
    else warnings.push(msg);
  } else if (isPlaceholderSecret(sessionSecret)) {
    const msg = "SESSION_SECRET looks like a placeholder; set a strong random value (≥32 chars)";
    if (opts.isProd) fatal.push(msg);
    else warnings.push(msg);
  } else if (sessionSecret.length < MIN_SESSION_SECRET_LEN) {
    const msg = `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LEN} characters`;
    if (opts.isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (!databaseUrl) {
    const msg = "DATABASE_URL is missing";
    if (opts.isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (opts.isProd) {
    const originOk = appOrigin ? isValidHttpsOriginOrUrl(appOrigin) : false;
    const urlOk = appUrl ? isValidHttpsOriginOrUrl(appUrl) : false;
    if (!originOk && !urlOk) {
      fatal.push("APP_ORIGIN or APP_URL must be a valid HTTPS URL in production");
    } else {
      if (appOrigin && !originOk) fatal.push("APP_ORIGIN must be a valid HTTPS URL in production");
      if (appUrl && !urlOk) fatal.push("APP_URL must be a valid HTTPS URL in production");
    }
  } else {
    if (appOrigin && !appOrigin.startsWith("http://") && !appOrigin.startsWith("https://")) {
      warnings.push("APP_ORIGIN should be an absolute http(s) URL");
    }
    if (appUrl && !appUrl.startsWith("http://") && !appUrl.startsWith("https://")) {
      warnings.push("APP_URL should be an absolute http(s) URL");
    }
  }

  if (!clientId) {
    const msg = "OAuth client id missing (X_CLIENT_ID or TWITTER_CLIENT_ID)";
    if (opts.isProd) fatal.push(msg);
    else warnings.push(msg);
  }
  if (!clientSecret) {
    const msg = "OAuth client secret missing (X_CLIENT_SECRET or TWITTER_CLIENT_SECRET)";
    if (opts.isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  const contact = resolveContactEmail(env);
  if (!contact) {
    const raw = String(env.CONTACT_EMAIL || env.PRIVACY_CONTACT_EMAIL || "").trim();
    const msg = raw
      ? "CONTACT_EMAIL (or PRIVACY_CONTACT_EMAIL) must be a valid public email address"
      : "CONTACT_EMAIL (or PRIVACY_CONTACT_EMAIL) is required for a public privacy contact";
    if (opts.isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  return { ok: fatal.length === 0, fatal, warnings };
}

/**
 * Assert production env is safe to boot.
 * In production: any fatal issue exits (or throws if throwOnFatal).
 * In development: logs warnings only.
 */
export function assertProductionEnv(
  env: EnvLike = process.env,
  options: AssertProductionEnvOptions = {}
): EnvValidationResult {
  const isProd = String(env.NODE_ENV || "").trim() === "production";
  const result = validateEnv(env, { isProd });
  const warn = options.warn ?? ((m: string) => console.warn(`[env] ${m}`));
  const error = options.error ?? ((m: string) => console.error(`[env] ${m}`));

  for (const w of result.warnings) warn(w);

  if (isProd && result.fatal.length > 0) {
    for (const f of result.fatal) error(f);
    const summary = `Refusing to start: ${result.fatal.length} production env error(s)`;
    error(summary);
    if (options.throwOnFatal) {
      throw new Error(summary);
    }
    const exit = options.exit ?? ((code: number) => process.exit(code) as never);
    exit(1);
  }

  return result;
}
