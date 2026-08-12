/**
 * Proposal access predicates that are intentionally separate from admin powers.
 * Full-universe preview can open admin_only/preview galaxies without privileged editing.
 */

import { isPrivilegedManualEditorHandle } from "./stanceHistory.js";

const FULL_UNIVERSE_PREVIEW_HANDLES = new Set(["hampus_s"]);

function normalizeHandle(handle: unknown): string {
  return String(handle ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

/** Authenticated tester who may open every enabled galaxy, without admin mutation rights. */
export function isFullUniversePreviewHandle(handle: unknown): boolean {
  return FULL_UNIVERSE_PREVIEW_HANDLES.has(normalizeHandle(handle));
}

/** May open admin_only / preview-restricted galaxies. */
export function canAccessAdminOnlyProposal(handle: unknown): boolean {
  return isPrivilegedManualEditorHandle(handle) || isFullUniversePreviewHandle(handle);
}
