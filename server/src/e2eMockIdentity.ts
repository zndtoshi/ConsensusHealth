/**
 * Test-only mock OAuth identity helpers.
 * Active only in strict test mode (NODE_ENV=test + CONSENSUSHEALTH_E2E) with X_OAUTH_MOCK.
 */

import { isEnvSwitchEnabled, isStrictTestMode } from "./security/testMode.js";

export const E2E_USER_COOKIE = "consensushealth_e2e_user";
/** Test-only OAuth failure mode cookie (token | deny | expired). Never set in production. */
export const E2E_OAUTH_FAIL_COOKIE = "consensushealth_e2e_oauth_fail";

export type E2EOauthFailMode = "token" | "deny" | "expired";

/** X-style handle max length. */
export const E2E_MOCK_HANDLE_MAX_LEN = 15;

export function isConsensusHealthE2E(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isStrictTestMode(env)) return false;
  return isEnvSwitchEnabled(env.X_OAUTH_MOCK);
}

export function parseE2EOauthFailMode(raw: unknown): E2EOauthFailMode | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "token" || v === "deny" || v === "expired") return v;
  return null;
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
 * Full fixed-width base36 of the 32-bit FNV-1a digest (always 7 chars).
 * Using the entire token preserves hash variation (unlike truncating to 4).
 */
export const E2E_MOCK_HANDLE_SUFFIX_LEN = 7;

export function deterministicMockHandleSuffix(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // uint32 max in base36 is "1z141z3" (7 chars); pad shorter values.
  return (h >>> 0).toString(36).padStart(E2E_MOCK_HANDLE_SUFFIX_LEN, "0");
}

/**
 * Deterministic X-style handle (≤15 chars, [a-z0-9_]) unique per e2e_user key.
 * Uses a readable `e2e_` + key prefix plus the full 7-char hash suffix so long
 * keys that share a prefix (e.g. stanced_bip54 / stanced_bip448) do not collide.
 */
export function buildE2EMockHandle(e2eUserKey: string): string {
  const key = String(e2eUserKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  const suffix = deterministicMockHandleSuffix(key || "x");
  const prefix = "e2e_";
  const maxReadable = E2E_MOCK_HANDLE_MAX_LEN - prefix.length - suffix.length;
  const readable = key.slice(0, Math.max(0, maxReadable));
  const handle = `${prefix}${readable}${suffix}`.replace(/[^a-z0-9_]/g, "");
  if (handle.length > 0 && handle.length <= E2E_MOCK_HANDLE_MAX_LEN) return handle;
  return `e2e${suffix}`.slice(0, E2E_MOCK_HANDLE_MAX_LEN);
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
        .replace(/^@+/, "")
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, E2E_MOCK_HANDLE_MAX_LEN),
      name: String(env.X_OAUTH_MOCK_NAME || "E2E Mock User").trim(),
    };
  }
  return {
    id: deterministicMockUserId(e2eUserKey),
    handle: buildE2EMockHandle(e2eUserKey),
    name: `E2E ${e2eUserKey}`,
  };
}
