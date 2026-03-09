export type StanceValue = "against" | "neutral" | "approve";

type AccountRecord = {
  handle?: unknown;
  stance?: unknown;
  position?: unknown;
  [key: string]: unknown;
};

function normalizeHandle(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^@+/, "");
}

export function isPrivilegedManualEditor(handle: unknown): boolean {
  return false;
}

export function applyManualStanceUpdate<T extends AccountRecord>(
  accounts: T[],
  targetHandle: string,
  nextStance: StanceValue
): T[] {
  const target = normalizeHandle(targetHandle);
  if (!target) return accounts;
  let changed = false;
  const out = accounts.map((a) => {
    const h = normalizeHandle(a?.handle);
    if (h !== target) return a;
    changed = true;
    return {
      ...a,
      stance: nextStance,
      position: nextStance,
    };
  });
  return changed ? out : accounts;
}
