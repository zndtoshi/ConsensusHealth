import { mapApiProposal, type ProposalApiItem, type ProposalConfig } from "../config/proposals";

export type ProposalsResponse = {
  generated_at?: string;
  admin_galaxies?: boolean;
  items: ProposalApiItem[];
};

export async function fetchAccessibleProposals(opts?: {
  apiBase?: string;
  signal?: AbortSignal;
}): Promise<{ adminGalaxies: boolean; items: ProposalConfig[] }> {
  const base = (opts?.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/proposals`, {
    credentials: "include",
    signal: opts?.signal,
  });
  if (!res.ok) throw new Error(`Failed to load proposals (${res.status})`);
  const data = (await res.json()) as ProposalsResponse;
  const items = Array.isArray(data.items) ? data.items.map(mapApiProposal) : [];
  return {
    adminGalaxies: Boolean(data.admin_galaxies),
    items,
  };
}
