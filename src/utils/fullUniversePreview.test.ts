import test from "node:test";
import assert from "node:assert/strict";
import { canUseFullProposalCatalog, isFullUniversePreviewUser } from "./fullUniversePreview";
import { isPrivilegedManualEditor } from "./manualEditState";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("hampus_s is a full-universe preview user but never a privileged editor", () => {
  assert.equal(isFullUniversePreviewUser("hampus_s"), true);
  assert.equal(isFullUniversePreviewUser("@Hampus_S"), true);
  assert.equal(isPrivilegedManualEditor("hampus_s"), false);
  assert.equal(canUseFullProposalCatalog("hampus_s"), true);
  assert.equal(canUseFullProposalCatalog("alice"), false);
  assert.equal(canUseFullProposalCatalog("zndtoshi"), true);
});

test("App fallback catalog uses full-universe preview without admin edit rights", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const appSrc = readFileSync(join(root, "src", "App.jsx"), "utf8");
  assert.match(appSrc, /canUseFullProposalCatalog/);
  assert.match(appSrc, /isPrivilegedManualEditor\(me\?\.handle\)/);
  assert.doesNotMatch(appSrc, /isPrivilegedManualEditor\("hampus_s"\)/);
});
