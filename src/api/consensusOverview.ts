import type { ConsensusOverviewPayload } from "../utils/consensusOverview";

export type { ConsensusOverviewPayload };

export async function fetchConsensusOverview(opts?: {
  apiBase?: string;
  signal?: AbortSignal;
}): Promise<ConsensusOverviewPayload> {
  const base = (opts?.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/consensus-overview`, {
    credentials: "include",
    signal: opts?.signal,
  });
  if (!res.ok) throw new Error(`Failed to load consensus overview (${res.status})`);
  return (await res.json()) as ConsensusOverviewPayload;
}
