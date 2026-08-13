/** Proposal access predicates for unpublished/admin-only galaxies. */

import { isPrivilegedManualEditorHandle } from "./stanceHistory.js";

/** Only the privileged editor may open unpublished/admin-only galaxies. */
export function canAccessAdminOnlyProposal(handle: unknown): boolean {
  return isPrivilegedManualEditorHandle(handle);
}
