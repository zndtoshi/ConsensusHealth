/**
 * Test-only mock OAuth identity helpers.
 * Active only in strict test mode (NODE_ENV=test + CONSENSUSHEALTH_E2E) with X_OAUTH_MOCK.
 */

import { isEnvSwitchEnabled, isStrictTestMode } from "./security/testMode.js";

export const E2E_USER_COOKIE = "consensushealth_e2e_user";

export function isConsensusHealthE2E(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isStrictTestMode(env)) return false;
  return isEnvSwitchEnabled(env.X_OAUTH_MOCK);
}

/** Safe e2e_user key: short alphanumeric / _ / - for query + cookie. */
export function parseE2EUserKey(raw: unknown): string | null {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(key)) return null;
  return key;
}

export type E2EMockIdentity = {
  id: string;
  handle: string;
  name: string;
};

/** Deterministic snowflake-like id from key (string math; no BigInt needed). */
export function deterministicMockUserId(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const abs = (h >>> 0).toString().padStart(10, "0");
  return `90000000${abs}`.slice(0, 19);
}

/**
 * Map e2e_user → mock X identity. When key is null, fall back to env defaults
 * (X_OAUTH_MOCK_USER_ID / HANDLE / NAME).
 */
export function resolveE2EMockIdentity(
  e2eUserKey: string | null,
  env: NodeJS.ProcessEnv = process.env
): E2EMockIdentity {
  if (!e2eUserKey) {
    return {
      id: String(env.X_OAUTH_MOCK_USER_ID || "9000000000000000001").trim(),
      handle: String(env.X_OAUTH_MOCK_HANDLE || "e2e_mock_user")
        .trim()
        .toLowerCase()
        .replace(/^@+/, ""),
      name: String(env.X_OAUTH_MOCK_NAME || "E2E Mock User").trim(),
    };
  }
  const handle = `e2e_${e2eUserKey}`.replace(/[^a-z0-9_]/g, "").slice(0, 15);
  return {
    id: deterministicMockUserId(e2eUserKey),
    handle: handle || `e2e${e2eUserKey}`.slice(0, 15),
    name: `E2E ${e2eUserKey}`,
  };
}
