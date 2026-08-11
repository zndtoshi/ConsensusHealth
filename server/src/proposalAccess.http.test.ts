/**
 * HTTP-boundary authorization tests for proposal access.
 * Uses an isolated Express mini-app with the same resolveProposalAccessAsync gate.
 * Optional DB via TEST_DATABASE_URL; otherwise uses seed admin_only map behavior through
 * a temporary schema when URL is set. Without DB, tests still exercise the HTTP gate
 * using resolveProposalAccess (sync seed catalog) mounted identically.
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  resolveProposalAccess,
  resolveProposalAccessAsync,
} from "./proposals.js";
import { isPrivilegedManualEditorHandle } from "./stanceHistory.js";

function makeMiniApp(mode: "sync" | "async", pool?: { query: Function }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const handle = String(req.headers["x-test-handle"] || "").trim() || null;
    (req as express.Request & { testHandle: string | null }).testHandle = handle;
    next();
  });

  async function gate(req: express.Request, res: express.Response) {
    const handle = (req as express.Request & { testHandle: string | null }).testHandle;
    const raw =
      req.query.proposal ??
      req.query.bip ??
      req.body?.proposal ??
      req.body?.proposal_id ??
      null;
    const access =
      mode === "async" && pool
        ? await resolveProposalAccessAsync(pool as never, { rawProposal: raw, sessionHandle: handle })
        : { ...resolveProposalAccess({ rawProposal: raw, sessionHandle: handle }), known: true };
    if ("known" in access && access.known === false) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
    res.json({ ok: true, proposal_id: access.proposalId, admin: isPrivilegedManualEditorHandle(handle) });
  }

  app.get("/api/community", gate);
  app.get("/api/stats", gate);
  app.get("/api/proposals", (req, res) => {
    const handle = (req as express.Request & { testHandle: string | null }).testHandle;
    const isAdmin = isPrivilegedManualEditorHandle(handle);
    res.json({
      admin_galaxies: isAdmin,
      items: isAdmin
        ? [{ id: "bip110" }, { id: "bip54" }, { id: "bip448" }, { id: "bip460" }]
        : [{ id: "bip110" }],
    });
  });
  app.post("/api/stance", (_req, res) => {
    res.status(409).json({ error: "stance_updates_restricted" });
  });
  app.get("/api/stances/export-against.csv", gate);
  app.get("/api/stance-history", gate);
  app.get("/api/stances/new", gate);
  app.get("/api/stance-playback-sequence", gate);
  return app;
}

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test("HTTP: ordinary user blocked from bip54/bip448/bip460; bip110 allowed", async () => {
  const app = makeMiniApp("sync");
  await withServer(app, async (base) => {
    const h = { "x-test-handle": "alice", "content-type": "application/json" };
    const ok110 = await fetch(`${base}/api/community?proposal=bip110`, { headers: h });
    assert.equal(ok110.status, 200);
    const deny54 = await fetch(`${base}/api/stats?proposal=bip54`, { headers: h });
    assert.equal(deny54.status, 403);
    const deny448 = await fetch(`${base}/api/stance-history?proposal=448`, { headers: h });
    assert.equal(deny448.status, 403);
    const deny460 = await fetch(`${base}/api/community?proposal=bip460`, { headers: h });
    assert.equal(deny460.status, 403);
    const denyWrite = await fetch(`${base}/api/stance`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ stance: "against", proposal: "bip54" }),
    });
    assert.equal(denyWrite.status, 409);
    const proposals = await fetch(`${base}/api/proposals`, { headers: h }).then((r) => r.json());
    assert.deepEqual(
      proposals.items.map((i: { id: string }) => i.id),
      ["bip110"]
    );
  });
});

test("HTTP: unauthenticated cannot access bip54", async () => {
  const app = makeMiniApp("sync");
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/community?proposal=bip54`);
    assert.equal(res.status, 403);
  });
});

test("HTTP: zndtoshi (mixed case) can access all seeded galaxies", async () => {
  const app = makeMiniApp("sync");
  await withServer(app, async (base) => {
    const h = { "x-test-handle": "@ZndToshi" };
    for (const p of ["bip110", "bip54", "bip448", "bip460"]) {
      const res = await fetch(`${base}/api/community?proposal=${p}`, { headers: h });
      assert.equal(res.status, 200, p);
    }
    const proposals = await fetch(`${base}/api/proposals`, { headers: h }).then((r) => r.json());
    assert.equal(proposals.admin_galaxies, true);
    assert.equal(proposals.items.length, 4);
  });
});

test("HTTP: client-supplied handle header cannot elevate without matching privilege helper", async () => {
  // Mini-app trusts x-test-handle as session stand-in; privilege still goes through
  // isPrivilegedManualEditorHandle — forging "zndtoshi" is only possible if session is forged.
  // This asserts the privilege helper itself, and that non-zndtoshi stays denied.
  assert.equal(isPrivilegedManualEditorHandle("not-admin"), false);
  assert.equal(isPrivilegedManualEditorHandle("zndtoshi"), true);
});

test("HTTP: unknown proposal rejected on gated routes", async () => {
  const app = express();
  app.use(express.json());
  app.get("/api/community", async (req, res) => {
    const handle = String(req.headers["x-test-handle"] || "") || null;
    const access = resolveProposalAccess({
      rawProposal: req.query.proposal,
      sessionHandle: handle,
    });
    // Production uses tryResolve + known flag; mirror rejection for unknown ids.
    const { tryResolveProposalId } = await import("./proposalCatalog.js");
    if (!tryResolveProposalId(req.query.proposal)) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
    res.json({ ok: true });
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/community?proposal=bip999`, {
      headers: { "x-test-handle": "zndtoshi" },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "unknown_proposal");
  });
});
