/**
 * HTTP-boundary authorization tests for proposal access.
 * Uses an isolated Express mini-app with the same resolveProposalAccessAsync gate.
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
import { getProposalById, isFinalProposalStatus } from "./proposalCatalog.js";

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
      items: [{ id: "bip110" }, { id: "bip54" }, { id: "bip448" }, { id: "bip460" }],
    });
  });
  app.post("/api/stance", (req, res) => {
    const handle = (req as express.Request & { testHandle: string | null }).testHandle;
    if (!handle) {
      res.status(401).json({ error: "not_logged_in" });
      return;
    }
    const access = resolveProposalAccess({
      rawProposal: req.body?.proposal ?? req.body?.proposal_id,
      sessionHandle: handle,
    });
    if (!access.allowed) {
      res.status(403).json({ error: "forbidden_proposal" });
      return;
    }
    const meta = getProposalById(access.proposalId);
    if (isFinalProposalStatus(meta?.status)) {
      res.status(409).json({ error: "proposal_stances_frozen" });
      return;
    }
    res.json({ ok: true, proposal_id: access.proposalId, stance: req.body?.stance });
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

test("HTTP: ordinary user can access public ongoing galaxies; BIP-110 write stays frozen", async () => {
  const app = makeMiniApp("sync");
  await withServer(app, async (base) => {
    const h = { "x-test-handle": "alice", "content-type": "application/json" };
    for (const p of ["bip110", "bip54", "bip448", "bip460"]) {
      const res = await fetch(`${base}/api/community?proposal=${p}`, { headers: h });
      assert.equal(res.status, 200, p);
    }
    const freeze110 = await fetch(`${base}/api/stance`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ stance: "against", proposal: "bip110" }),
    });
    assert.equal(freeze110.status, 409);
    const write54 = await fetch(`${base}/api/stance`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ stance: "approve", proposal: "bip54" }),
    });
    assert.equal(write54.status, 200);
    const proposals = await fetch(`${base}/api/proposals`, { headers: h }).then((r) => r.json());
    assert.deepEqual(
      proposals.items.map((i: { id: string }) => i.id),
      ["bip110", "bip54", "bip448", "bip460"]
    );
  });
});

test("HTTP: unauthenticated can view bip54 but cannot write", async () => {
  const app = makeMiniApp("sync");
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/community?proposal=bip54`);
    assert.equal(res.status, 200);
    const write = await fetch(`${base}/api/stance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stance: "against", proposal: "bip54" }),
    });
    assert.equal(write.status, 401);
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
  assert.equal(isPrivilegedManualEditorHandle("not-admin"), false);
  assert.equal(isPrivilegedManualEditorHandle("zndtoshi"), true);
});

test("HTTP: unknown proposal rejected on gated routes", async () => {
  const app = express();
  app.use(express.json());
  app.get("/api/community", async (req, res) => {
    const handle = String(req.headers["x-test-handle"] || "") || null;
    const { tryResolveProposalId } = await import("./proposalCatalog.js");
    if (!tryResolveProposalId(req.query.proposal)) {
      res.status(400).json({ error: "unknown_proposal" });
      return;
    }
    const access = resolveProposalAccess({
      rawProposal: req.query.proposal,
      sessionHandle: handle,
    });
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
