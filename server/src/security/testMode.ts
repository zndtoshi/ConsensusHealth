/**
 * Strict test-mode guards for E2E / mock OAuth switches.
 *
 * Mock login and other E2E-only flags must never activate in production,
 * regardless of env var values. Production startup fails loudly if any
 * test-only switch is set.
 */

export type EnvLike = Record<string, string | undefined>;

export type AssertTestModeOptions = {
  /** When true, throw instead of process.exit (for tests). Default false. */
  throwOnFatal?: boolean;
  error?: (message: string) => void;
  exit?: (code: number) => never;
};

const ENABLING = new Set(["1", "true", "yes", "on"]);

/** True when the raw env value looks like an intentional enable switch. */
export function isEnvSwitchEnabled(raw: unknown): boolean {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return ENABLING.has(v);
}

/**
 * Strict test mode: NODE_ENV=test (or equivalently strict marker) AND an
 * explicit E2E allow flag. Never true in production.
 */
export function isStrictTestMode(env: EnvLike = process.env): boolean {
  const nodeEnv = String(env.NODE_ENV || "")
    .trim()
    .toLowerCase();
  if (nodeEnv === "production") return false;
  const isTestEnv = nodeEnv === "test" || isEnvSwitchEnabled(env.CONSENSUSHEALTH_STRICT_TEST);
  if (!isTestEnv) return false;
  return isEnvSwitchEnabled(env.CONSENSUSHEALTH_E2E);
}

const TEST_SWITCH_KEYS = [
  "X_OAUTH_MOCK",
  "E2E_SERVE_DIST",
  "FORCE_LISTEN",
  "CONSENSUSHEALTH_E2E",
  "HELMET_PROD",
  "X_OAUTH_MOCK_USER_ID",
  "X_OAUTH_MOCK_HANDLE",
  "X_OAUTH_MOCK_NAME",
  "X_OAUTH_MOCK_AVATAR",
] as const;

function productionForbiddenTestSwitches(env: EnvLike): string[] {
  const found: string[] = [];
  for (const key of TEST_SWITCH_KEYS) {
    const raw = env[key];
    if (raw == null || String(raw).trim() === "") continue;
    // Mock identity fields are only meaningful when set; any non-empty value in prod is forbidden.
    if (key.startsWith("X_OAUTH_MOCK_")) {
      found.push(key);
      continue;
    }
    if (isEnvSwitchEnabled(raw)) found.push(key);
  }
  return found;
}

/**
 * If NODE_ENV=production and any test-only switch is enabled (or mock identity
 * vars are set), refuse to start.
 */
export function assertNoTestSwitchesInProduction(
  env: EnvLike = process.env,
  options: AssertTestModeOptions = {}
): void {
  const nodeEnv = String(env.NODE_ENV || "")
    .trim()
    .toLowerCase();
  if (nodeEnv !== "production") return;

  const bad = productionForbiddenTestSwitches(env);
  if (bad.length === 0) return;

  const error =
    options.error ?? ((m: string) => console.error(`[test-mode] ${m}`));
  const summary = `Refusing to start: test-only switch(es) set in production: ${bad.join(", ")}`;
  error(summary);
  if (options.throwOnFatal) {
    throw new Error(summary);
  }
  const exit = options.exit ?? ((code: number) => process.exit(code) as never);
  exit(1);
}

function resolveTestSwitch(env: EnvLike, key: string): boolean {
  if (!isStrictTestMode(env)) return false;
  return isEnvSwitchEnabled(env[key]);
}

/** Serve built frontend from dist/ — E2E only. */
export function resolveE2eServeDist(env: EnvLike = process.env): boolean {
  return resolveTestSwitch(env, "E2E_SERVE_DIST");
}

/** Deterministic mock X OAuth — E2E only. */
export function resolveXOauthMock(env: EnvLike = process.env): boolean {
  return resolveTestSwitch(env, "X_OAUTH_MOCK");
}

/** Force HTTP listen even when imported — E2E only. */
export function resolveForceListen(env: EnvLike = process.env): boolean {
  return resolveTestSwitch(env, "FORCE_LISTEN");
}

/**
 * Production-equivalent Helmet/CSP during E2E (HTTP-safe: caller should skip
 * HSTS / upgrade-insecure-requests on plain HTTP).
 */
export function resolveHelmetProd(env: EnvLike = process.env): boolean {
  if (String(env.NODE_ENV || "").trim().toLowerCase() === "production") return true;
  return resolveTestSwitch(env, "HELMET_PROD");
}
