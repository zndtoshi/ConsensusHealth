import { defineConfig, devices } from "@playwright/test";

/**
 * Real-backend launch E2E when a Postgres URL is available.
 * CI always provides TEST_DATABASE_URL (see .github/workflows/ci.yml).
 * Locally: export TEST_DATABASE_URL or E2E_DATABASE_URL (do not rely on server/.env
 * alone — that would fail hard if Postgres is down). Without a URL the suite
 * skips (exit 0); CI fails fast if missing.
 */
const databaseUrl = (
  process.env.E2E_DATABASE_URL ||
  process.env.TEST_DATABASE_URL ||
  (process.env.CI ? process.env.DATABASE_URL : "") ||
  ""
).trim();

const useRealBackend = Boolean(databaseUrl);

if (process.env.CI && !useRealBackend) {
  throw new Error(
    "Playwright CI requires TEST_DATABASE_URL (or DATABASE_URL). Postgres service must be up."
  );
}

// Visible to test files (same Node process / worker env).
process.env.E2E_REAL_BACKEND = useRealBackend ? "1" : "0";

const E2E_ORIGIN = "http://127.0.0.1:8787";
const E2E_PORT = "8787";
const SESSION_SECRET =
  process.env.SESSION_SECRET?.trim() || "e2e_session_secret_at_least_32_chars_long";

const realBackendEnv: Record<string, string> = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  E2E_SERVE_DIST: "1",
  X_OAUTH_MOCK: "1",
  FORCE_LISTEN: "1",
  CONSENSUSHEALTH_E2E: "1",
  HELMET_PROD: "1",
  CONTACT_EMAIL: process.env.CONTACT_EMAIL?.trim() || "privacy@example.com",
  SESSION_SECRET,
  APP_URL: E2E_ORIGIN,
  APP_ORIGIN: E2E_ORIGIN,
  FRONTEND_BASE_URL: E2E_ORIGIN,
  PORT: E2E_PORT,
  // Strict test mode — mock/serve flags only resolve when NODE_ENV=test + E2E allow.
  NODE_ENV: "test",
  // Dummy OAuth credentials — required by startXAuth even when X_OAUTH_MOCK=1.
  X_CLIENT_ID: process.env.X_CLIENT_ID?.trim() || "e2e_mock_x_client_id",
  X_CLIENT_SECRET: process.env.X_CLIENT_SECRET?.trim() || "e2e_mock_x_client_secret",
  X_OAUTH_MOCK_USER_ID: process.env.X_OAUTH_MOCK_USER_ID?.trim() || "9000000000000000001",
  X_OAUTH_MOCK_HANDLE: process.env.X_OAUTH_MOCK_HANDLE?.trim() || "e2e_mock_user",
  X_OAUTH_MOCK_NAME: process.env.X_OAUTH_MOCK_NAME?.trim() || "E2E Mock User",
  // Low dual write ceiling so real IP/account 429 tests finish quickly (test mode only).
  E2E_STANCE_WRITE_MAX: process.env.E2E_STANCE_WRITE_MAX?.trim() || "3",
  E2E_REAL_BACKEND: "1",
};

if (!useRealBackend) {
  console.warn(
    "[playwright] No E2E_DATABASE_URL / TEST_DATABASE_URL — skipping real-backend E2E. Set TEST_DATABASE_URL to run locally."
  );
}

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  maxFailures: process.env.CI ? 1 : 0,
  // Auth/stance/delete mutate shared mock user + DB — keep serial.
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 90_000,
  use: {
    baseURL: E2E_ORIGIN,
    trace: "on-first-retry",
  },
  webServer: useRealBackend
    ? {
        command: "node scripts/build-web-for-e2e.mjs && npx tsx server/src/index.ts",
        url: `${E2E_ORIGIN}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        env: realBackendEnv,
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
