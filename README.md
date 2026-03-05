# ConsensusHealth

ConsensusHealth is a Vite frontend + Node/Express backend service with Postgres and X OAuth.

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
- return `dist/index.html` for non-API SPA routes

## Environment Variables

Use `server/env.example` as the template for local and deploy env config.

Required/important variables:

- `DATABASE_URL` - Postgres connection string (with password)
- `PORT` - server listen port (Render sets this automatically)
- `APP_ORIGIN` - allowed CORS origin (dev default: `http://localhost:5173`)
- `FRONTEND_BASE_URL` - OAuth post-login redirect base
  - dev: `http://localhost:5173`
  - same-origin production: set to your site origin (or leave unset to use `APP_ORIGIN`)
- `SESSION_SECRET` - signed cookie secret
- `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI` - X OAuth settings

## Render Deployment (single web service)

Typical Render settings:

- Build command: `npm install && npm run build`
- Start command: `npm run start`
- Add env vars from `server/env.example` (except local-only defaults)

After deploy, opening the service URL should load the frontend app, and API routes remain available under the same origin.
