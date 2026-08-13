# Launch smoke checklist

CI runs automated Playwright launch E2E against a real API + Postgres (`e2e/launch-backend.spec.ts`, `X_OAUTH_MOCK=1`, `E2E_SERVE_DIST=1`) plus unit/integration tests. Use this after deploy or for checks that still need a real X account.

## Static / routing

- [ ] `/` loads Consensus Health shell
- [ ] `/bip/54`, `/bip/110`, `/bip/448`, `/bip/460` each show the matching galaxy / header label
- [ ] `/privacy`, `/terms`, `/how-it-works` open the info panel; Esc or Close returns to a `/bip/…` path without a full reload
- [ ] `robots.txt` and `sitemap.xml` are reachable
- [ ] `og-card.png` returns 200 (SVG may remain as an optional alternate)

## API

- [ ] `GET /api/health` → 200 `{ ok: true }`
- [ ] `GET /api/ready` → 200 when DB is up
- [ ] `GET /api/proposals` returns enabled BIPs
- [ ] `GET /api/community?proposal=bip110` returns accounts (or empty array, not 5xx)

## Auth + stance (staging / disposable account)

- [ ] Sign in with X
- [ ] First-vote disclosure shows Privacy / Terms once; “Got it” persists (`ch_privacy_disclosure_v1`)
- [ ] Choose stance on an ongoing BIP; appears on graph after refresh
- [ ] Optional explanation URL flow (attach / remove)
- [ ] Log out clears session chip

## Account deletion (disposable account only)

- [ ] Account menu → Delete my account and data
- [ ] Wrong handle keeps dialog open with error
- [ ] Correct handle deletes; session cleared; user gone from community list

## Failure polish

- [ ] With API down / bad `DATABASE_URL`, UI shows branded maintenance + Retry (not a blank crash, not raw internal errors)
