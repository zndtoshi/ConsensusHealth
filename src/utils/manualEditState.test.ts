import test from "node:test";
import assert from "node:assert/strict";
import {
  applyManualStanceUpdate,
  isPrivilegedManualEditor,
  publicExplanationForStance,
  removeAccountFromList,
} from "./manualEditState";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("privileged manual editor is only zndtoshi", () => {
  assert.equal(isPrivilegedManualEditor("zndtoshi"), true);
  assert.equal(isPrivilegedManualEditor("@zndtoshi"), true);
  assert.equal(isPrivilegedManualEditor("ZndToshi "), true);
  assert.equal(isPrivilegedManualEditor("someone_else"), false);
  assert.equal(isPrivilegedManualEditor("hampus_s"), false);
});

test("manual stance update preserves profile stats and avatar", () => {
  const original = [
    {
      handle: "niftynei",
      followers_count: 12345,
      avatar_url: "https://pbs.twimg.com/profile_images/x.jpg",
      avatar_path: "/avatars/niftynei.jpg",
      stance: "approve",
      name: "Nifty",
    },
  ];
  const updated = applyManualStanceUpdate(original, "niftynei", "against");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.stance, "against");
  assert.equal(updated[0]?.followers_count, 12345);
  assert.equal(updated[0]?.avatar_url, "https://pbs.twimg.com/profile_images/x.jpg");
  assert.equal(updated[0]?.avatar_path, "/avatars/niftynei.jpg");
  assert.equal(updated[0]?.name, "Nifty");
});

test("admin/manual stance change suppresses mismatched public explanation immediately", () => {
  const original = [
    {
      handle: "alice",
      stance: "approve",
      stance_explanation: {
        tweet_id: "1",
        tweet_text: "old approve explanation",
        canonical_url: "https://x.com/alice/status/1",
        stance_at_verification: "approve",
      },
    },
  ];
  const updated = applyManualStanceUpdate(original, "alice", "against");
  assert.equal(updated[0]?.stance, "against");
  assert.equal(updated[0]?.stance_explanation, null);
  assert.equal(
    publicExplanationForStance(original[0]?.stance_explanation, "against"),
    null
  );
  assert.equal(
    publicExplanationForStance(original[0]?.stance_explanation, "approve")?.tweet_id,
    "1"
  );

  const appSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf8");
  assert.match(appSrc, /suppressNodePublicExplanation/);
  assert.match(appSrc, /saveManualStanceEdit/);
  const manualSave = appSrc.slice(appSrc.indexOf("async function saveManualStanceEdit"));
  assert.match(manualSave.slice(0, 2500), /applyManualStanceUpdate/);
  assert.match(manualSave.slice(0, 2500), /suppressNodePublicExplanation/);
});

test("manual stance update changes only matching handle", () => {
  const original = [
    { handle: "alice", followers_count: 10, stance: "neutral" },
    { handle: "bob", followers_count: 20, stance: "approve" },
  ];
  const updated = applyManualStanceUpdate(original, "bob", "against");
  assert.equal(updated[0]?.stance, "neutral");
  assert.equal(updated[1]?.stance, "against");
  assert.equal(updated[1]?.followers_count, 20);
});

test("removeAccountFromList drops matching handle or x_user_id", () => {
  const original = [
    { handle: "alice", x_user_id: "1", stance: "neutral" },
    { handle: "bob", x_user_id: "2", stance: "approve" },
    { handle: "carol", x_user_id: "3", stance: "against" },
  ];
  const byHandle = removeAccountFromList(original, { handle: "bob" });
  assert.deepEqual(
    byHandle.map((a) => a.handle),
    ["alice", "carol"]
  );
  const byId = removeAccountFromList(original, { x_user_id: "3" });
  assert.deepEqual(
    byId.map((a) => a.handle),
    ["alice", "bob"]
  );
});
