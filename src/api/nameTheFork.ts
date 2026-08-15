import type { NameTheForkPayload } from "./nameTheForkTypes";

export type { NameTheForkPayload };

export async function fetchNameTheFork(opts?: {
  apiBase?: string;
  signal?: AbortSignal;
}): Promise<NameTheForkPayload> {
  const base = (opts?.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork`, {
    credentials: "include",
    signal: opts?.signal,
  });
  if (!res.ok) throw new Error(`Failed to load Name the Fork (${res.status})`);
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String(data?.error || `vote_failed_${res.status}`));
    (err as Error & { code?: string }).code = String(data?.error || "");
    throw err;
  }
  return data as NameTheForkPayload;
}

export async function deleteNameTheForkVote(opts?: {
  apiBase?: string;
}): Promise<NameTheForkPayload> {
  const base = (opts?.apiBase || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/name-the-fork/vote`, {
    method: "DELETE",
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String(data?.error || `remove_failed_${res.status}`));
    (err as Error & { code?: string }).code = String(data?.error || "");
    throw err;
  }
  return data as NameTheForkPayload;
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String(data?.error || `candidate_failed_${res.status}`));
    (err as Error & { code?: string }).code = String(data?.error || "");
    throw err;
  }
  return data as NameTheForkPayload;
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String(data?.error || `hide_failed_${res.status}`));
    (err as Error & { code?: string }).code = String(data?.error || "");
    throw err;
  }
  return data as NameTheForkPayload;
}
