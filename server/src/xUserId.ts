/**
 * X user IDs are opaque digit strings (snowflakes). Never coerce through JS Number.
 */

export type KnownRoundedXUserId = {
  handle: string;
  roundedId: string;
  exactId: string;
};

/** Production rows that failed join-date backfill due to IEEE-rounded seed IDs. */
export const KNOWN_ROUNDED_X_USER_IDS: readonly KnownRoundedXUserId[] = [
  {
    handle: "brian_trollz",
    roundedId: "721049861399949300",
    exactId: "721049861399949313",
  },
  {
    handle: "mononautical",
    roundedId: "1386812674156253200",
    exactId: "1386812674156253196",
  },
  {
    handle: "heavilyarmedc",
    roundedId: "937317022064558100",
    exactId: "937317022064558080",
  },
  {
    handle: "elinagar",
    roundedId: "1565721906959028200",
    exactId: "1565721906959028224",
  },
  {
    handle: "darosior",
    roundedId: "1088099386742239200",
    exactId: "1088099386742239234",
  },
  {
    handle: "dathon_ohm",
    roundedId: "1987353263008850000",
    exactId: "1987353263008849922",
  },
  {
    handle: "l0rinc",
    roundedId: "722877922692862000",
    exactId: "722877922692861952",
  },
] as const;

const KNOWN_ROUNDED_BY_HANDLE = new Map(
  KNOWN_ROUNDED_X_USER_IDS.map((r) => [r.handle, r] as const)
);
const KNOWN_ROUNDED_ID_SET = new Set(KNOWN_ROUNDED_X_USER_IDS.map((r) => r.roundedId));

export function normalizeHandle(value: unknown): string | null {
  const h = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
  return h || null;
}

/** Digit-only X snowflake (no Number()/parseInt). */
export function isDigitOnlyXUserId(value: unknown): boolean {
  return typeof value === "string" && /^\d+$/.test(value);
}

/**
 * Coerce an X user id to a digit string without Number()/parseInt()/unary +.
 * Rejects JS numbers (may already be rounded). Accepts bigint and digit strings.
 */
export function coerceXUserIdToDigitString(value: unknown): string | null {
  if (typeof value === "bigint") {
    const s = value.toString();
    return /^\d+$/.test(s) ? s : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) return s;
    return null;
  }
  // Numbers are untrusted: IEEE doubles cannot hold snowflakes exactly.
  return null;
}

/** Any non-empty x_user_id string (digit snowflake or manual:handle). */
export function coerceXUserIdKey(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const s = value.trim();
    return s || null;
  }
  return null;
}

/**
 * True when a digit string is unsafe as a JS number or matches a known rounded seed.
 * Detection may compare against Number() but must never use Number() as the ID itself.
 */
export function isUnsafeOrRoundedXUserId(value: unknown): boolean {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(id)) return false;
  if (KNOWN_ROUNDED_ID_SET.has(id)) return true;
  // X snowflakes are 64-bit; 16+ digit strings are outside Number.MAX_SAFE_INTEGER.
  if (id.length >= 16) return true;
  // eslint-disable-next-line no-restricted-syntax -- detection only; result is never stored as an ID
  return String(Number(id)) !== id;
}

export function knownRoundedRecordForHandle(handle: unknown): KnownRoundedXUserId | null {
  const h = normalizeHandle(handle);
  if (!h) return null;
  return KNOWN_ROUNDED_BY_HANDLE.get(h) ?? null;
}

/**
 * Quote long digit values for known id keys before JSON.parse so snowflakes stay exact.
 */
export function quoteSnowflakeIdFieldsInJsonText(text: string): string {
  return text.replace(
    /("(?:id|x_user_id|xUserId|userId|user_id)"\s*:\s*)(-?\d{15,})(\s*[,}\]])/g,
    '$1"$2"$3'
  );
}

export function parseJsonPreservingSnowflakeIds(text: string): unknown {
  return JSON.parse(quoteSnowflakeIdFieldsInJsonText(text));
}

export type RoundedIdRepairInput = {
  repairRoundedIdsEnabled: boolean;
  /** Lookup must have been by handle for repair. */
  lookupWasByHandle: boolean;
  requestedHandle: string | null;
  returnedHandle: string | null;
  storedId: string | null;
  returnedId: string | null;
  joinDateIsNull: boolean;
  accountCreatedAt: string | null;
  /** True when another community_users row already owns returnedId. */
  exactIdOwnedByOtherRow: boolean;
};

export type RoundedIdRepairDecision =
  | {
      action: "repair";
      oldId: string;
      newId: string;
      createdAt: string;
      handle: string;
    }
  | { action: "reject_conflict"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "accept_without_id_change"; reason: string };

/**
 * Decide whether a rounded-ID repair is allowed. Without the flag, ID mismatches stay conflicts.
 */
export function evaluateRoundedIdRepair(input: RoundedIdRepairInput): RoundedIdRepairDecision {
  const requested = normalizeHandle(input.requestedHandle);
  const returned = normalizeHandle(input.returnedHandle);
  const storedId = coerceXUserIdToDigitString(input.storedId) ?? (input.storedId?.trim() || null);
  const returnedId = coerceXUserIdToDigitString(input.returnedId);

  if (!input.repairRoundedIdsEnabled) {
    if (storedId && returnedId && storedId !== returnedId) {
      return { action: "reject_conflict", reason: "identity_conflict_strict" };
    }
    return { action: "accept_without_id_change", reason: "ids_match_or_missing" };
  }

  if (!input.joinDateIsNull) {
    return { action: "skip", reason: "join_date_already_populated" };
  }
  if (!input.lookupWasByHandle) {
    return { action: "reject_conflict", reason: "lookup_was_not_by_handle" };
  }
  if (!requested || !returned || requested !== returned) {
    return { action: "reject_conflict", reason: "handle_mismatch" };
  }
  if (!returnedId || !isDigitOnlyXUserId(returnedId)) {
    return { action: "skip", reason: "returned_id_not_digit_string" };
  }
  if (!input.accountCreatedAt) {
    return { action: "skip", reason: "missing_account_created_at" };
  }
  if (!storedId) {
    // No stored digit id — normal persist can attach returned id without "repair".
    return { action: "accept_without_id_change", reason: "no_stored_digit_id" };
  }
  if (storedId === returnedId) {
    return { action: "accept_without_id_change", reason: "ids_already_equal" };
  }
  if (!isUnsafeOrRoundedXUserId(storedId) && !knownRoundedRecordForHandle(requested)) {
    return { action: "reject_conflict", reason: "stored_id_not_marked_unsafe_or_known" };
  }
  // Known record: stored should match the known rounded id when present.
  const known = knownRoundedRecordForHandle(requested);
  if (known && storedId !== known.roundedId && storedId !== known.exactId) {
    // Still allow if unsafe length heuristic, but log via reason if exactId owned
  }
  if (input.exactIdOwnedByOtherRow) {
    return { action: "reject_conflict", reason: "exact_id_owned_by_other_row" };
  }

  return {
    action: "repair",
    oldId: storedId,
    newId: returnedId,
    createdAt: input.accountCreatedAt,
    handle: requested,
  };
}
