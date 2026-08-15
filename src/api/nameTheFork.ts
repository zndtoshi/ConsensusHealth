import type { NameTheForkPayload } from "./nameTheForkTypes";

export type { NameTheForkPayload };

async function parsePayload(res: Response): Promise<NameTheForkPayload> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String((data as { error?: string })?.error || `request_failed_${res.status}`));
    (err as Error & { code?: string }).code = String((data as { error?: string })?.error || "");
    throw err;
  }
  return data as NameTheForkPayload;
}

export async function fetchNameTheFork(opts?: {
  apiBase?: string;
  signal?: AbortSignal;
}): Promise<NameTheForkPayload> {
  const base = (opts?.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork`, {
    credentials: "include",
    signal: opts?.signal,
  });
  if (!res.ok) throw new Error(`Failed to load Name the PoW change fork (${res.status})`);
  return (await res.json()) as NameTheForkPayload;
}

export async function postNameTheForkVote(opts: {
  apiBase?: string;
  candidateId: string;
}): Promise<NameTheForkPayload> {
  const base = (opts.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork/vote`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_id: opts.candidateId }),
  });
  return parsePayload(res);
}

export async function deleteNameTheForkVote(opts?: {
  apiBase?: string;
}): Promise<NameTheForkPayload> {
  const base = (opts?.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork/vote`, {
    method: "DELETE",
    credentials: "include",
  });
  return parsePayload(res);
}

export async function postNameTheForkCandidate(opts: {
  apiBase?: string;
  displayName: string;
}): Promise<NameTheForkPayload> {
  const base = (opts.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork/candidates`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: opts.displayName }),
  });
  return parsePayload(res);
}

export async function postNameTheForkApprove(opts: {
  apiBase?: string;
  candidateId: string;
}): Promise<NameTheForkPayload> {
  const base = (opts.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork/admin/approve`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_id: opts.candidateId }),
  });
  return parsePayload(res);
}

export async function postNameTheForkReject(opts: {
  apiBase?: string;
  candidateId: string;
}): Promise<NameTheForkPayload> {
  const base = (opts.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork/admin/reject`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_id: opts.candidateId }),
  });
  return parsePayload(res);
}

export async function postNameTheForkHide(opts: {
  apiBase?: string;
  candidateId: string;
}): Promise<NameTheForkPayload> {
  const base = (opts.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork/admin/hide`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidate_id: opts.candidateId }),
  });
  return parsePayload(res);
}
