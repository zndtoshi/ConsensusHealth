import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  coerceXUserIdToDigitString,
  evaluateRoundedIdRepair,
  isUnsafeOrRoundedXUserId,
  KNOWN_ROUNDED_X_USER_IDS,
  parseJsonPreservingSnowflakeIds,
  quoteSnowflakeIdFieldsInJsonText,
} from "./xUserId.js";
import {
  buildJoinDateCandidates,
  listKnownRoundedRepairCandidates,
  parseBackfillArgs,
} from "./joinDateBackfill.js";
import { mapEnrichment, requestTwitterApiIo } from "./profileEnrichment.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991

test("IDs above Number.MAX_SAFE_INTEGER retain exact digits as strings", () => {
  const exact = "721049861399949313";
  assert.ok(BigInt(exact) > BigInt(MAX_SAFE));
  // eslint-disable-next-line no-restricted-syntax -- prove Number is lossy
  assert.notEqual(String(Number(exact)), exact);
  assert.equal(coerceXUserIdToDigitString(exact), exact);
  assert.equal(coerceXUserIdToDigitString(Number(exact)), null);
});

test("JSON seed IDs load as strings with exact digits", () => {
  const seedPath = path.resolve(process.cwd(), "public", "data", "accounts_stanced.json");
  const raw = fs.readFileSync(seedPath, "utf8");
  assert.match(raw, /"x_user_id"\s*:\s*"/);
  assert.doesNotMatch(raw, /"x_user_id"\s*:\s*\d/);
  const data = parseJsonPreservingSnowflakeIds(raw) as Array<Record<string, unknown>>;
  const brian = data.find((r) => String(r.handle).toLowerCase() === "brian_trollz");
  assert.equal(typeof brian?.x_user_id, "string");
  assert.equal(brian?.x_user_id, "721049861399949313");
});

test("API response IDs remain strings when emitted as JSON numbers", async () => {
  const snowflake = "721049861399949313";
  const fetchImpl = async () =>
    new Response(`{"data":{"id":${snowflake},"userName":"brian_trollz","createdAt":"2010-01-01T00:00:00.000Z"}}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const result = await requestTwitterApiIo("/twitter/user/info", { userName: "brian_trollz" }, "k", fetchImpl as typeof fetch);
  const id = (result.json as { data?: { id?: unknown } } | null)?.data?.id;
  assert.equal(typeof id, "string");
  assert.equal(id, snowflake);
});

test("mapEnrichment keeps digit string ids and rejects JS numbers", () => {
  const ok = mapEnrichment({ id: "1386812674156253196", userName: "mononautical" });
  assert.equal(ok?.id, "1386812674156253196");
  // eslint-disable-next-line no-restricted-syntax
  const bad = mapEnrichment({ id: Number("1386812674156253196"), userName: "mononautical" });
  assert.equal(bad?.id, null);
});

test("exact string comparison distinguishes rounded vs exact", () => {
  const rounded = "721049861399949300";
  const exact = "721049861399949313";
  assert.notEqual(rounded, exact);
  assert.equal(isUnsafeOrRoundedXUserId(rounded), true);
  assert.equal(isUnsafeOrRoundedXUserId(exact), true); // 16+ digits
});

test("parseBackfillArgs recognizes --repair-rounded-ids", () => {
  const args = parseBackfillArgs(["--repair-rounded-ids", "--verbose", "--dry-run"]);
  assert.equal(args.repairRoundedIds, true);
  assert.equal(args.verbose, true);
  assert.equal(args.dryRun, true);
  assert.equal(parseBackfillArgs([]).repairRoundedIds, false);
});

test("known rounded IDs are repaired only with --repair-rounded-ids", () => {
  const base = {
    lookupWasByHandle: true,
    requestedHandle: "brian_trollz",
    returnedHandle: "brian_trollz",
    storedId: "721049861399949300",
    returnedId: "721049861399949313",
    joinDateIsNull: true,
    accountCreatedAt: "2016-01-01T00:00:00.000Z",
    exactIdOwnedByOtherRow: false,
  };
  const denied = evaluateRoundedIdRepair({ ...base, repairRoundedIdsEnabled: false });
  assert.equal(denied.action, "reject_conflict");

  const allowed = evaluateRoundedIdRepair({ ...base, repairRoundedIdsEnabled: true });
  assert.equal(allowed.action, "repair");
  if (allowed.action === "repair") {
    assert.equal(allowed.oldId, "721049861399949300");
    assert.equal(allowed.newId, "721049861399949313");
    assert.equal(allowed.createdAt, "2016-01-01T00:00:00.000Z");
  }
});

test("handle mismatch prevents repair", () => {
  const decision = evaluateRoundedIdRepair({
    repairRoundedIdsEnabled: true,
    lookupWasByHandle: true,
    requestedHandle: "brian_trollz",
    returnedHandle: "someone_else",
    storedId: "721049861399949300",
    returnedId: "721049861399949313",
    joinDateIsNull: true,
    accountCreatedAt: "2016-01-01T00:00:00.000Z",
    exactIdOwnedByOtherRow: false,
  });
  assert.equal(decision.action, "reject_conflict");
  if (decision.action === "reject_conflict") assert.equal(decision.reason, "handle_mismatch");
});

test("duplicate canonical ID prevents repair", () => {
  const decision = evaluateRoundedIdRepair({
    repairRoundedIdsEnabled: true,
    lookupWasByHandle: true,
    requestedHandle: "brian_trollz",
    returnedHandle: "brian_trollz",
    storedId: "721049861399949300",
    returnedId: "721049861399949313",
    joinDateIsNull: true,
    accountCreatedAt: "2016-01-01T00:00:00.000Z",
    exactIdOwnedByOtherRow: true,
  });
  assert.equal(decision.action, "reject_conflict");
  if (decision.action === "reject_conflict") {
    assert.equal(decision.reason, "exact_id_owned_by_other_row");
  }
});

test("normal unexpected ID conflicts are still rejected without repair flag", () => {
  const decision = evaluateRoundedIdRepair({
    repairRoundedIdsEnabled: false,
    lookupWasByHandle: true,
    requestedHandle: "someone",
    returnedHandle: "someone",
    storedId: "111",
    returnedId: "222",
    joinDateIsNull: true,
    accountCreatedAt: "2016-01-01T00:00:00.000Z",
    exactIdOwnedByOtherRow: false,
  });
  assert.equal(decision.action, "reject_conflict");
});

test("account_created_at is required for verified repair decision", () => {
  const decision = evaluateRoundedIdRepair({
    repairRoundedIdsEnabled: true,
    lookupWasByHandle: true,
    requestedHandle: "l0rinc",
    returnedHandle: "l0rinc",
    storedId: "722877922692862000",
    returnedId: "722877922692861952",
    joinDateIsNull: true,
    accountCreatedAt: null,
    exactIdOwnedByOtherRow: false,
  });
  assert.equal(decision.action, "skip");
});

test("populated join dates are skipped (idempotent / no repair)", () => {
  const decision = evaluateRoundedIdRepair({
    repairRoundedIdsEnabled: true,
    lookupWasByHandle: true,
    requestedHandle: "brian_trollz",
    returnedHandle: "brian_trollz",
    storedId: "721049861399949300",
    returnedId: "721049861399949313",
    joinDateIsNull: false,
    accountCreatedAt: "2016-01-01T00:00:00.000Z",
    exactIdOwnedByOtherRow: false,
  });
  assert.equal(decision.action, "skip");
});

test("buildJoinDateCandidates ignores JS number x_user_id values", () => {
  const candidates = buildJoinDateCandidates([
    // eslint-disable-next-line no-restricted-syntax
    { handle: "brian_trollz", x_user_id: Number("721049861399949313"), source: "seed" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.lookupXUserId, null);
  assert.equal(candidates[0]?.handle, "brian_trollz");
});

test("listKnownRoundedRepairCandidates includes the seven known handles", () => {
  const list = listKnownRoundedRepairCandidates([]);
  assert.equal(list.length, KNOWN_ROUNDED_X_USER_IDS.length);
  assert.ok(list.every((r) => r.expectedExactId && r.storedId));
});

test("quoteSnowflakeIdFieldsInJsonText preserves digits above MAX_SAFE_INTEGER", () => {
  const raw = `{"id":721049861399949313,"x_user_id":1386812674156253196}`;
  const quoted = quoteSnowflakeIdFieldsInJsonText(raw);
  const parsed = JSON.parse(quoted) as { id: string; x_user_id: string };
  assert.equal(parsed.id, "721049861399949313");
  assert.equal(parsed.x_user_id, "1386812674156253196");
});

test("arberash is not in known rounded repair list (no fabricated date)", () => {
  assert.equal(
    KNOWN_ROUNDED_X_USER_IDS.some((r) => r.handle === "arberash"),
    false
  );
});
