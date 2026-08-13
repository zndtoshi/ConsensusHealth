/**
 * Real Postgres + HTTP integration: privacy deletion through production public surfaces.
 * Requires TEST_DATABASE_URL. Zero skips.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import {
  clearSeededAccountsCache,
  createPrivacyPublicSurfacesRouter,
  type CommunitySessionUser,
} from "../communityPublicSurfaces.js";
import { ensurePrivacySuppressionsTable } from "../privacySuppressions.js";
import {
  assertSafeTestDatabaseUrl,
  createIsolatedSchemaPool,
  ensureAccountDeletionSchema,
  getRequiredTestDatabaseUrl,
  uniqueTestId,
} from "./helpers.js";

const TEST_DATABASE_URL = getRequiredTestDatabaseUrl();
assertSafeTestDatabaseUrl(TEST_DATABASE_URL);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SEED_PATH = join(ROOT, "public", "data", "accounts_stanced.json");

type SeedAccount = {
  handle: string;
  stance?: string;
  x_user_id?: string;
  name?: string;
  followers_count?: number;
};

function loadBundledBip110Seed(): SeedAccount[] {
  const raw = readFileSync(SEED_PATH, "utf8");
  const data = JSON.parse(raw) as SeedAccount[];
  assert.ok(Array.isArray(data) && data.length > 0, "bundled BIP110 seed required");
  return data;
}

function pickCuratedSeedIdentity(seed: SeedAccount[]): {
  x_user_id: string;
  handle: string;
  stance: string;
  name: string;
  followers_count: number;
  seedRow: SeedAccount;
} {
  const withId = seed.find((a) => String(a.x_user_id || "").trim() && String(a.handle || "").trim());
  assert.ok(withId, "need at least one seed account with x_user_id");
  const x_user_id = String(withId.x_user_id).trim();
  const handle = String(withId.handle).trim().toLowerCase().replace(/^@+/, "");
  return {
    x_user_id,
    handle,
    stance: String(withId.stance || "against"),
    name: String(withId.name || handle),
    followers_count: Number(withId.followers_count) || 1000,
    seedRow: withId,
  };
}

async function seedDbUser(
  pool: Pool,
  user: {
    x_user_id: string;
    handle: string;
    bip110Stance?: string;
    name?: string;
    followers_count?: number;
  }
) {
  await pool.query(
    `INSERT INTO community_users (x_user_id, handle, name, followers_count, stance, avatar_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      user.x_user_id,
      user.handle,
      user.name ?? user.handle,
      user.followers_count ?? 100,
      user.bip110Stance ?? "against",
      `/avatars/${user.x_user_id}.jpg`,
    ]
  );
  await pool.query(
    `INSERT INTO user_proposal_stances (x_user_id, proposal_id, stance)
     VALUES ($1, 'bip110', $2)`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO user_proposal_stance_history
       (x_user_id, proposal_id, previous_stance, new_stance, changed_by)
     VALUES ($1, 'bip110', NULL, $2, 'user')`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO stance_history (x_user_id, previous_stance, new_stance, changed_by)
     VALUES ($1, NULL, $2, 'user')`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO stance_events (x_user_id, from_stance, to_stance)
     VALUES ($1, NULL, $2)`,
    [user.x_user_id, user.bip110Stance ?? "against"]
  );
  await pool.query(
    `INSERT INTO sessions (session_id, x_user_id, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [`sess_${user.x_user_id}`, user.x_user_id]
  );
}

function accountPresent(
  rows: Array<Record<string, unknown>>,
  identity: { x_user_id: string; handle: string }
): boolean {
  const handle = identity.handle.toLowerCase();
  return rows.some((r) => {
    const id = String(r.x_user_id ?? "").trim();
    const h = String(r.handle ?? "")
      .trim()
      .toLowerCase()
      .replace(/^@+/, "");
    return id === identity.x_user_id || h === handle;
  });
}

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test("integration: privacy deletion via real public HTTP surfaces (community/csv/stats/history/playback/new + re-login)", async () => {
  clearSeededAccountsCache();
  const seed = loadBundledBip110Seed();
  const curated = pickCuratedSeedIdentity(seed);
  const controlHandle = `ctrl_${uniqueTestId("c").slice(-8)}`;
  const controlId = uniqueTestId("ctrl_xid");

  // Injected seed list: real curated identity + a survivor that must remain visible.
  const injectedSeed: SeedAccount[] = [
    {
      ...curated.seedRow,
      handle: curated.handle,
      x_user_id: curated.x_user_id,
      stance: curated.stance,
    },
    // Case-variant of curated handle (must still be suppressed by handle_normalized).
    {
      handle: curated.handle.toUpperCase(),
      x_user_id: "",
      stance: curated.stance,
      name: "CaseVariant",
      followers_count: 50,
    },
    // Same X id, mismatched handle (must still be suppressed by x_user_id).
    {
      handle: `mismatch_${curated.handle}`,
      x_user_id: curated.x_user_id,
      stance: curated.stance,
      name: "IdOnly",
      followers_count: 50,
    },
    {
      handle: "SeedSurvivorOk",
      x_user_id: uniqueTestId("seed_ok"),
      stance: "approve",
      name: "Survivor",
      followers_count: 200,
    },
  ];

  const iso = await createIsolatedSchemaPool("privpub");
  let sessionUser: CommunitySessionUser | null = {
    x_user_id: curated.x_user_id,
    handle: curated.handle,
    name: curated.name,
    avatar_url: null,
    followers_count: curated.followers_count,
  };

  try {
    await ensureAccountDeletionSchema(iso.pool);
    await ensurePrivacySuppressionsTable(iso.pool);

    await seedDbUser(iso.pool, {
      x_user_id: curated.x_user_id,
      handle: curated.handle,
      bip110Stance: curated.stance,
      name: curated.name,
      followers_count: curated.followers_count,
    });
    await seedDbUser(iso.pool, {
      x_user_id: controlId,
      handle: controlHandle,
      bip110Stance: "neutral",
      name: "Control",
      followers_count: 10,
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createPrivacyPublicSurfacesRouter({
        pool: iso.pool,
        getSessionUser: () => sessionUser,
        avatarsDir: join(ROOT, "public", "avatars"),
        loadSeededAccounts: async () => injectedSeed as Record<string, unknown>[],
        loadExplanations: async () => new Map(),
        selfStanceUpdatesEnabled: true,
      })
    );

    await withServer(app, async (base) => {
      const beforeCommunity = await fetch(`${base}/api/community?proposal=bip110`);
      assert.equal(beforeCommunity.status, 200);
      const beforeRows = (await beforeCommunity.json()) as Array<Record<string, unknown>>;
      assert.ok(
        accountPresent(beforeRows, curated),
        "curated identity must appear before deletion"
      );
      assert.ok(
        accountPresent(beforeRows, { x_user_id: controlId, handle: controlHandle }),
        "control user present"
      );

      const del = await fetch(`${base}/api/me/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm_handle: curated.handle }),
      });
      assert.equal(del.status, 200);
      const delBody = (await del.json()) as Record<string, unknown>;
      assert.equal(delBody.ok, true);
      assert.equal(delBody.suppressed, true);

      // Idempotent already-deleted.
      const delAgain = await fetch(`${base}/api/me/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm_handle: curated.handle }),
      });
      assert.equal(delAgain.status, 200);
      const delAgainBody = (await delAgain.json()) as Record<string, unknown>;
      assert.equal(delAgainBody.ok, true);
      assert.equal(delAgainBody.suppressed, true);

      const community = await fetch(`${base}/api/community?proposal=bip110`);
      assert.equal(community.status, 200);
      const communityRows = (await community.json()) as Array<Record<string, unknown>>;
      assert.ok(!accountPresent(communityRows, curated), "curated identity absent from community");
      assert.ok(
        !communityRows.some(
          (r) =>
            String(r.handle ?? "")
              .toLowerCase()
              .replace(/^@+/, "") === curated.handle.toUpperCase().toLowerCase() &&
            String(r.name ?? "") === "CaseVariant"
        ),
        "case-changed seed handle suppressed"
      );
      assert.ok(
        !communityRows.some(
          (r) => String(r.handle ?? "").toLowerCase() === `mismatch_${curated.handle}`
        ),
        "x_user_id mismatch-handle seed suppressed"
      );
      assert.ok(
        communityRows.some(
          (r) =>
            String(r.handle ?? "")
              .toLowerCase()
              .replace(/^@+/, "") === "seedsurvivorok"
        ),
        "unrelated seed survives"
      );
      assert.ok(
        accountPresent(communityRows, { x_user_id: controlId, handle: controlHandle }),
        "control DB user still visible"
      );

      for (const path of [
        "/api/stances/export-against.csv",
        "/api/stances/export-neutral.csv",
        "/api/stances/export-approve.csv",
      ]) {
        const csvRes = await fetch(`${base}${path}?proposal=bip110`);
        assert.equal(csvRes.status, 200);
        const csv = await csvRes.text();
        assert.doesNotMatch(
          csv,
          new RegExp(`(^|,|"|\\s)${curated.handle}(,|"|\\s|$)`, "i"),
          `${path} must not include suppressed handle`
        );
        assert.doesNotMatch(csv, new RegExp(curated.x_user_id));
      }

      const stats = await fetch(`${base}/api/stats?proposal=bip110`);
      assert.equal(stats.status, 200);
      const statsBody = (await stats.json()) as {
        counts: { against: number; neutral: number; approve: number };
        top_account: Record<string, { handle: string | null }>;
        recent_changes: Array<{ handle: string | null }>;
      };
      assert.equal(statsBody.counts.neutral, 1);
      assert.equal(statsBody.counts.against + statsBody.counts.approve, 0);
      for (const key of ["against", "neutral", "approve"] as const) {
        const h = statsBody.top_account[key]?.handle;
        if (h) assert.notEqual(h.toLowerCase(), curated.handle);
      }
      assert.ok(
        !statsBody.recent_changes.some((c) => (c.handle || "").toLowerCase() === curated.handle)
      );

      const history = await fetch(`${base}/api/stance-history?proposal=bip110&limit=50`);
      assert.equal(history.status, 200);
      const historyBody = (await history.json()) as {
        items: Array<{ handle: string | null }>;
      };
      assert.ok(
        !historyBody.items.some((i) => (i.handle || "").toLowerCase() === curated.handle),
        "history must not surface deleted identity"
      );

      const playback = await fetch(`${base}/api/stance-playback-sequence?proposal=bip110`);
      assert.equal(playback.status, 200);
      const playbackBody = (await playback.json()) as {
        items: Array<{ x_user_id: string; handle: string }>;
      };
      assert.ok(!playbackBody.items.some((i) => i.x_user_id === curated.x_user_id));
      assert.ok(!playbackBody.items.some((i) => i.handle === curated.handle));

      const newStances = await fetch(`${base}/api/stances/new?proposal=bip110&limit=9`);
      assert.equal(newStances.status, 200);
      const newBody = (await newStances.json()) as {
        items: Array<{ xUserId: string; handle: string }>;
      };
      assert.ok(!newBody.items.some((i) => i.xUserId === curated.x_user_id));
      assert.ok(!newBody.items.some((i) => i.handle === curated.handle));

      // Re-login: same X id may create ongoing bip54 stance; BIP110 remains frozen + seed suppressed.
      sessionUser = {
        x_user_id: curated.x_user_id,
        handle: curated.handle,
        name: curated.name,
        avatar_url: null,
        followers_count: curated.followers_count,
      };

      const bip110Write = await fetch(`${base}/api/stance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stance: "approve", proposal: "bip110" }),
      });
      assert.equal(bip110Write.status, 409);
      const bip110Err = (await bip110Write.json()) as { error?: string };
      assert.equal(bip110Err.error, "proposal_stances_frozen");

      const bip54Write = await fetch(`${base}/api/stance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stance: "approve", proposal: "bip54" }),
      });
      assert.equal(bip54Write.status, 200);
      const bip54Body = (await bip54Write.json()) as Record<string, unknown>;
      assert.equal(bip54Body.ok, true);
      assert.equal(bip54Body.proposal_id, "bip54");

      const bip54Community = await fetch(`${base}/api/community?proposal=bip54`);
      assert.equal(bip54Community.status, 200);
      const bip54Payload = (await bip54Community.json()) as {
        accounts: Array<Record<string, unknown>>;
      };
      assert.ok(
        accountPresent(bip54Payload.accounts, curated),
        "re-login bip54 self-reported stance is visible"
      );

      const bip110AfterRelogin = await fetch(`${base}/api/community?proposal=bip110`);
      assert.equal(bip110AfterRelogin.status, 200);
      const bip110Rows = (await bip110AfterRelogin.json()) as Array<Record<string, unknown>>;
      assert.ok(
        !accountPresent(bip110Rows, curated),
        "BIP110 curated seed stays suppressed after re-login"
      );
    });
  } finally {
    await iso.cleanup();
    clearSeededAccountsCache();
  }
});

test("integration: production frontend still refuses seed fallback when community API fails", () => {
  const appSrc = readFileSync(join(ROOT, "src", "App.jsx"), "utf8");
  assert.match(appSrc, /import\.meta\.env\.PROD/);
  assert.match(appSrc, /community_unavailable/);
  assert.match(appSrc, /privacy suppressions|bypasses privacy/i);
  assert.match(appSrc, /Dev-only fixture fallback/);
});
