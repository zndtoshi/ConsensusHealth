function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("localhost") || trimmed.startsWith("127.0.0.1")) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

export function getAppUrl(): string {
  const fromApp = normalizeBaseUrl(process.env.APP_URL || "");
  if (fromApp) return fromApp;

  const fromRender = normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL || "");
  if (fromRender) return fromRender;

  const port = Number(process.env.PORT || 8787);
  return `http://localhost:${Number.isFinite(port) ? port : 8787}`;
}

export function getXRedirectUri(): string {
  return `${getAppUrl()}/auth/x/callback`;
}

export function logConfig(): void {
  const appEnv = (process.env.APP_URL || "").trim() || "(unset)";
  const appUrl = getAppUrl();
  const xRedirectUri = getXRedirectUri();
  console.log(`[ConsensusHealth config] APP_URL env: ${appEnv}`);
  console.log(`[ConsensusHealth config] appUrl: ${appUrl}`);
  console.log(`[ConsensusHealth config] xRedirectUri: ${xRedirectUri}`);
}
