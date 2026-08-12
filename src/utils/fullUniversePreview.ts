/**
 * Authenticated full-universe preview testers may see every enabled galaxy UI
 * without receiving privileged/admin mutation controls.
 */

function normalizeHandle(handle: unknown): string {
  return String(handle ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

const FULL_UNIVERSE_PREVIEW_HANDLES = new Set(["hampus_s"]);

export function isFullUniversePreviewUser(handle: unknown): boolean {
  return FULL_UNIVERSE_PREVIEW_HANDLES.has(normalizeHandle(handle));
}

export function canUseFullProposalCatalog(handle: unknown): boolean {
  const h = normalizeHandle(handle);
  return h === "zndtoshi" || FULL_UNIVERSE_PREVIEW_HANDLES.has(h);
}
