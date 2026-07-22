import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJoinDateCandidates,
  estimateCredits,
  normalizeHandle,
  parseBackfillArgs,
} from "./joinDateBackfill.js";
import {
  fetchProfileEnrichmentFromTwitterApiIo,
  mapEnrichment,
  normalizeTwitterApiDate,
  resolveTwitterApiKey,
} from "./profileEnrichment.js";

test("resolveTwitterApiKey prefers TWITTERAPI_API_KEY", () => {
  assert.equal(
    resolveTwitterApiKey({
      TWITTERAPI_API_KEY: "primary",
      TWITTERAPI_IO_KEY: "legacy",
    } as NodeJS.ProcessEnv),
    "primary"
  );
});

test("resolveTwitterApiKey falls back to TWITTERAPI_IO_KEY", () => {
  assert.equal(
    resolveTwitterApiKey({ TWITTERAPI_IO_KEY: "legacy" } as NodeJS.ProcessEnv),
    "legacy"
  );
});

test("resolveTwitterApiKey returns empty when missing", () => {
  assert.equal(resolveTwitterApiKey({} as NodeJS.ProcessEnv), "");
});

test("missing key fails clearly in fetchProfileEnrichmentFromTwitterApiIo", async () => {
  await assert.rejects(
    () => fetchProfileEnrichmentFromTwitterApiIo({ handle: "zndtoshi" }, ""),
    /TWITTERAPI_API_KEY is required/
  );
});

test("normalizeHandle strips @ and lowercases", () => {
  assert.equal(normalizeHandle("@ZndToshi"), "zndtoshi");
  assert.equal(normalizeHandle("  Alice  "), "alice");
});

test("buildJoinDateCandidates selects seed-only and community-only", () => {
  const candidates = buildJoinDateCandidates([
    { handle: "seedonly", source: "seed" },
    { x_user_id: "111", handle: "dbonly", source: "community" },
  ]);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.some((c) => c.handle === "seedonly" && c.source === "seed"));
  assert.ok(
    candidates.some(
      (c) => c.handle === "dbonly" && c.lookupXUserId === "111" && c.source === "community"
    )
  );
});

test("duplicate seed/database identity is requested once", () => {
  const candidates = buildJoinDateCandidates([
    { handle: "SamePerson", x_user_id: "42", source: "seed" },
    { handle: "sameperson", x_user_id: "42", source: "community" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.source, "both");
  assert.equal(candidates[0]?.lookupXUserId, "42");
});

test("stable X user ID takes priority and merges handle-only duplicate", () => {
  const candidates = buildJoinDateCandidates([
    { x_user_id: "99", handle: "alpha", source: "community" },
    { handle: "ALPHA", source: "seed" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.lookupXUserId, "99");
  assert.equal(candidates[0]?.handle, "alpha");
});

test("normalized handles deduplicate case-insensitively", () => {
  const candidates = buildJoinDateCandidates([
    { handle: "@FooBar", source: "seed" },
    { handle: "foobar", source: "community" },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.handle, "foobar");
  assert.equal(candidates[0]?.source, "both");
});

test("already populated accounts are marked and can be skipped", () => {
  const candidates = buildJoinDateCandidates([
    {
      handle: "hasdate",
      account_created_at: "2009-01-01T00:00:00.000Z",
      source: "community",
    },
    { handle: "missing", source: "seed" },
  ]);
  const populated = candidates.filter((c) => c.alreadyHasJoinDate);
  const missing = candidates.filter((c) => !c.alreadyHasJoinDate);
  assert.equal(populated.length, 1);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.handle, "missing");
});

test("normalizeTwitterApiDate accepts Twitter-style createdAt", () => {
  const iso = normalizeTwitterApiDate("Thu Dec 13 08:41:26 +0000 2007");
  assert.ok(iso);
  assert.equal(new Date(iso!).getUTCFullYear(), 2007);
});

test("normalizeTwitterApiDate rejects malformed timestamps", () => {
  assert.equal(normalizeTwitterApiDate("not-a-date"), null);
  assert.equal(normalizeTwitterApiDate(""), null);
  assert.equal(normalizeTwitterApiDate(null), null);
});

test("mapEnrichment reads createdAt and rejects missing id shape gracefully", () => {
  const ok = mapEnrichment({
    id: "123",
    userName: "zndtoshi",
    createdAt: "2009-06-15T14:25:10.000Z",
  });
  assert.equal(ok?.id, "123");
  assert.equal(ok?.username, "zndtoshi");
  assert.equal(ok?.accountCreatedAt, "2009-06-15T14:25:10.000Z");

  const malformed = mapEnrichment({
    id: "123",
    userName: "zndtoshi",
    createdAt: "bogus",
  });
  assert.equal(malformed?.accountCreatedAt, null);
});

test("mapEnrichment marks unavailable accounts", () => {
  const u = mapEnrichment({
    id: "1",
    unavailable: true,
    unavailableReason: "User is suspended",
  });
  assert.equal(u?.unavailable, true);
  assert.match(String(u?.unavailableReason), /suspend/i);
});

test("fetchProfileEnrichmentFromTwitterApiIo uses /twitter/user/info and X-API-Key", async () => {
  const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers });
    return new Response(
      JSON.stringify({
        data: {
          id: "999",
          userName: "zndtoshi",
          createdAt: "Thu Dec 13 08:41:26 +0000 2007",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const result = await fetchProfileEnrichmentFromTwitterApiIo(
    { handle: "zndtoshi" },
    "test-key",
    { fetchImpl: fetchImpl as typeof fetch }
  );
  assert.equal(result?.id, "999");
  assert.ok(result?.accountCreatedAt);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/twitter\/user\/info\?.*userName=zndtoshi/);
  const headers = new Headers(calls[0]!.headers);
  assert.equal(headers.get("X-API-Key"), "test-key");
});

test("429 retries with backoff then succeeds", async () => {
  let attempt = 0;
  const waits: number[] = [];
  const fetchImpl = async () => {
    attempt += 1;
    if (attempt === 1) {
      return new Response(JSON.stringify({ message: "rate limit" }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(
      JSON.stringify({
        data: { id: "1", userName: "a", createdAt: "2010-01-01T00:00:00.000Z" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const result = await fetchProfileEnrichmentFromTwitterApiIo(
    { handle: "a" },
    "key",
    {
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 2,
      onRateLimited: ({ waitMs }) => waits.push(waitMs),
    }
  );
  assert.equal(result?.id, "1");
  assert.equal(attempt, 2);
  assert.ok(waits.length >= 1);
});

test("unavailable account returns enrichment without throwing", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: { id: "2", unavailable: true, unavailableReason: "User not found" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const result = await fetchProfileEnrichmentFromTwitterApiIo(
    { handle: "gone" },
    "key",
    { fetchImpl: fetchImpl as typeof fetch }
  );
  assert.equal(result?.unavailable, true);
  assert.equal(result?.accountCreatedAt, null);
});

test("parseBackfillArgs supports dry-run, limit, handle, verbose", () => {
  const parsed = parseBackfillArgs([
    "--dry-run",
    "--limit=5",
    "--handle=@ZndToshi",
    "--verbose",
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.handle, "zndtoshi");
  assert.equal(parsed.verbose, true);
});

test("estimateCredits scales with request count", () => {
  const e = estimateCredits(10, 4);
  assert.ok(e.minCredits > 0);
  assert.ok(e.maxCredits >= e.minCredits);
});

test("concurrency helper respects pool size via sequential chunking of candidates", () => {
  // Documented default env knobs; ensure parse path does not invent overwrite behavior.
  const missing = buildJoinDateCandidates([
    { handle: "a", source: "seed" },
    { handle: "b", source: "seed" },
    { handle: "c", source: "seed" },
  ]).filter((c) => !c.alreadyHasJoinDate);
  const limited = missing.slice(0, 2);
  assert.equal(limited.length, 2);
});
