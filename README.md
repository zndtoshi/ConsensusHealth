# ConsensusHealth

ConsensusHealth is a Vite frontend + Node/Express backend service with Postgres and X OAuth.

Public site: [https://consensus.health](https://consensus.health)

## Development

Install dependencies:

```bash
npm install
```

Run frontend + backend:

```bash
npm run dev
```

- Frontend (Vite): `http://localhost:5173`
- API server: `http://localhost:8787`

## Production Build

Build frontend and compiled server output:

```bash
npm run build
```

This generates:

- Frontend: `dist/`
- Server JS: `server/dist/`

## Production Start

Start as one Node service:

```bash
npm run start
```

The server will:

- serve API routes (`/api/*`, `/auth/*`, `/dev/*`)
- serve static frontend files from `dist/`
- return `dist/index.html` for non-API SPA routes (including `/privacy`, `/terms`, `/how-it-works`, `/bip/*`)

Health:

- `GET /api/health` — liveness
- `GET /api/ready` — readiness (Postgres)

## Environment Variables

Use `server/env.example` as the template for local and deploy env config.

Required/important variables:

- `DATABASE_URL` - Postgres connection string (with password)
- `PORT` - server listen port (Render sets this automatically)
- `APP_URL` - canonical public base URL used for OAuth redirect URI generation
  - local: `http://localhost:8787`
  - Render/prod: `https://consensus.health`
- `APP_ORIGIN` - allowed CORS origin (dev default: `http://localhost:5173`)
- `FRONTEND_BASE_URL` - OAuth post-login redirect base
  - dev: `http://localhost:5173`
  - same-origin production: set to your site origin (or leave unset to use `APP_ORIGIN`)
- `SESSION_SECRET` - signed cookie secret (**≥ 32 characters** in production; no placeholders)
- `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI` - X OAuth settings
- `CONTACT_EMAIL` - privacy / security contact shown in ops validation; pair with `VITE_CONTACT_EMAIL` for the Privacy page in the web build
- `VITE_CONTACT_EMAIL` - frontend contact string for Privacy
- `VITE_API_BASE` - optional API origin for split local dev (empty when same-origin)

Account deletion (authenticated):

```http
POST /api/me/delete
Content-Type: application/json

{ "confirm_handle": "yourhandle" }
```

Rate limiting notes live in `server/env.example` and `server/src/security/rateLimits.ts`.

## Launch docs

- [docs/launch-runbook.md](docs/launch-runbook.md) — health, backups, rollback, env, OG limitations
- [docs/launch-smoke-checklist.md](docs/launch-smoke-checklist.md) — post-deploy smoke (CI runs Playwright real-backend E2E)

```bash
npm run build:web
node scripts/launch-static-smoke.mjs
node scripts/check-secrets.mjs
```

## Render Deployment (single web service)

Typical Render settings:

- Build command: `npm install && npm run build`
- Start command: `npm run start`
- Add env vars from `server/env.example` (except local-only defaults)
- Ensure `APP_URL` is set (for example: `https://consensus.health`)
- Set `CONTACT_EMAIL` and build-time `VITE_CONTACT_EMAIL`

After deploy, opening the service URL should load the frontend app, and API routes remain available under the same origin.

## License and forks

ConsensusHealth's source code is open source under the [MIT License](LICENSE). Anyone may fork, use, modify, and redistribute the code, including for commercial purposes, provided the license and copyright notice are retained.

The MIT license applies to the project-authored source code and documentation. Third-party material—such as X profile images, public social-content datasets, linked Bitcoin proposal material, and trademarks—is not relicensed and remains subject to its original owners' rights. The license also does not provide ConsensusHealth deployment secrets, X API credentials, private user data, production database contents, or permission to impersonate the official `consensus.health` service.
