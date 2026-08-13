# Consensus Health — launch runbook

Canonical production origin: `https://consensus.health` (see README).

## Health and readiness

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness — process is up (no DB). |
| `GET /api/ready` | Readiness — Postgres `SELECT 1` within timeout; `503` when not ready. |

On Render, point the health check at `/api/health` (or `/api/ready` if you want deploy traffic gated on DB).

Uptime monitoring should alert on:

- Sustained non-200 from `/api/ready`
- Elevated 5xx on `/api/*`
- Auth or stance write error spikes

## Environment checklist

Required / important (see `server/env.example`):

- `DATABASE_URL`
- `SESSION_SECRET` — strong random, **≥ 32 characters**, never a placeholder
- `APP_URL` — public API/site URL used for OAuth redirect generation
- `APP_ORIGIN` / `FRONTEND_BASE_URL` — CORS and post-login redirect
- `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`
- `CONTACT_EMAIL` — required valid public contact in production (served to the UI via `GET /api/public-config`; optional build-time `VITE_CONTACT_EMAIL` is only a fallback)
- Optional: `PRIVACY_CONTACT_EMAIL` fallback
- `SESSION_TTL_DAYS` — session cookie lifetime; Privacy copy uses this value from `/api/public-config`
- `BACKUP_RETENTION_DAYS` — operator-declared backup retention (days) for this deployment; Privacy and `/api/public-config` expose it. Set to the policy you actually keep for provider snapshots (not a Render SLA claim).
- `TRUST_PROXY_MODE` — `render_direct` (default) or `cloudflare_origin_lock`
- For `cloudflare_origin_lock`: set `CF_ORIGIN_SECRET` (≥32 chars) and configure Cloudflare to send it on `X-Origin-Verify` (or `CF_ORIGIN_SECRET_HEADER`). Origin returns 403 without it (health/ready exempt). Rate limiters then use `CF-Connecting-IP`.

Never set `X_OAUTH_MOCK`, `E2E_SERVE_DIST`, `FORCE_LISTEN`, `CONSENSUSHEALTH_E2E`, or `X_OAUTH_MOCK_*` in production — startup fails if any are present. Playwright uses `NODE_ENV=test` + `CONSENSUSHEALTH_E2E=1` so those switches resolve only in strict test mode.

### Cloudflare origin-lock procedure

1. Generate a high-entropy secret (≥32 characters) and set `CF_ORIGIN_SECRET` on Render.
2. Set `TRUST_PROXY_MODE=cloudflare_origin_lock`.
3. In Cloudflare, add a Transform / Worker rule that sets `X-Origin-Verify` to the same secret for origin requests.
4. Confirm direct Render URL access (without the header) returns `403` on `/api/community` while `/api/health` still returns 200.
5. Confirm rate limiting keys distinct visitor IPs from `CF-Connecting-IP` for two browsers behind Cloudflare.

Rate limits (in-memory, per instance):

- General `/api/*`: 120 / minute
- Auth: 20 / 15 minutes
- Stance / explanation writes: 30 / 15 minutes (keyed by IP + user when signed in)
- Account deletion: 10 / 15 minutes
- Multi-instance: switch to a shared store later (documented in `server/src/security/rateLimits.ts`)

Account deletion: authenticated `POST /api/me/delete` with `{ "confirm_handle": "<handle>" }`.

## Backups

- Enable automated Postgres backups on the host (Render / provider snapshots).
- Set `BACKUP_RETENTION_DAYS` to the retention you publish for this deployment (see Privacy / `/api/public-config`). This is an operator-declared policy, not a provider SLA invention.
- Confirm restore region before launch.
- Store a recent logical dump off-platform for disaster recovery drills.

## Restore drill checklist

1. Provision a scratch database from the latest backup.
2. Point a staging instance at the restore (`DATABASE_URL` only on staging).
3. Hit `/api/ready`, then smoke-login with a test X app (or staging credentials).
4. Confirm proposal catalog, one galaxy load, and `/api/me`.
5. Record time-to-restore and any schema migration gaps.
6. Tear down scratch credentials.

## Rollback

1. Keep the previous Render deploy (or git tag) one click away.
2. If a bad frontend ships: redeploy the last known-good build artifact.
3. If a bad migration ships: restore DB from backup **before** re-enabling writes; do not “fix forward” on production data without a plan.
4. Disable self-stance writes via feature flag / env only if that control exists; otherwise take the service to maintenance and restore.

## Smoke checks after deploy

See [launch-smoke-checklist.md](./launch-smoke-checklist.md).

Minimum:

1. `/` loads galaxy shell
2. `/bip/54`, `/bip/110`, `/bip/448`, `/bip/460` route
3. `/privacy`, `/terms`, `/how-it-works` open and Esc closes back to a BIP path
4. `/api/health` and `/api/ready` return 200
5. Login → choose stance on an ongoing BIP → logout
6. Optional: account deletion on a disposable test account

## Social / OG cards

- Default share card: `/og-card.svg` (referenced from `index.html`).
- Some platforms prefer PNG; convert `public/og-card.svg` → `og-card.png` (1200×630) when needed and update meta tags.
- **Limitation:** per-BIP Open Graph cards need server-side rendering (or prerender) of route-specific meta tags. The SPA cannot serve distinct OG HTML per `/bip/*` to crawlers without SSR. Documented intentionally — ship a site-wide card at launch.

## Browser E2E

Playwright (`npm run test:e2e` or CI) starts the real server with `NODE_ENV=test`, `CONSENSUSHEALTH_E2E=1`, mock OAuth / serve-dist / force-listen, and `HELMET_PROD=1` (production-equivalent CSP without HTTPS upgrades on localhost). Requires `TEST_DATABASE_URL` (or `E2E_DATABASE_URL`).
