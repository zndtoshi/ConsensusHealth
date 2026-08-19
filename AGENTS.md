# Agent Workflow

This repository uses a multi-agent development workflow.

## Roles

### Codex

Codex is the:

- project manager
- technical lead
- first-line implementer for minor fixes
- independent reviewer

Codex should:

- understand the product and codebase
- clarify requirements
- define acceptance criteria
- implement small, low-risk fixes directly
- delegate substantial implementation work to Claude Opus
- recommend Claude Fable only when deeper architectural planning is genuinely useful
- review Claude's actual Git diff and tests
- give a clear `APPROVE` or `REVISIONS REQUIRED` verdict

Codex should not delegate work merely for process ceremony.

Minor fixes Codex may implement directly include:

- small bugs
- styling/UI adjustments
- text changes
- simple logic corrections
- small configuration changes
- narrow, obvious refactors

Substantial work should normally go to Claude Opus.

### Claude Opus

Claude Opus is the primary implementation agent for substantial work.

Opus should:

- read `tasks.md` before starting
- inspect the relevant existing code
- implement only the approved requirements
- use a feature branch unless explicitly instructed otherwise
- keep changes scoped
- preserve unrelated behavior
- follow existing architecture and conventions
- run relevant tests, linting, builds, or checks
- never merge to `main`
- stop and report serious ambiguity or architectural blockers instead of silently redesigning the task

When finished, Opus should update the implementation sections of `tasks.md` and mark the task ready for Codex review.

### Claude Fable

Claude Fable is an on-demand architecture and implementation-planning specialist.

Fable should be used only when a task genuinely benefits from deeper planning, such as:

- major architecture changes
- database/schema migrations
- complex state or data flow
- difficult performance work
- security-sensitive changes
- large cross-cutting features
- unclear or risky implementation approaches

Fable should inspect the repository deeply and create a detailed implementation plan.

Fable may create planning/documentation files, including:

`/plans/<feature-name>.md`

Fable should not modify production/application code unless explicitly authorized.

After producing a plan, Fable should stop so Codex can review it before Opus implements it.

### Model-switch protocol for important tasks

- Claude Opus remains the preferred model for writing application code.
- For a very important, high-risk, or architecturally significant task, Codex must put an explicit `/model` instruction in `tasks.md` telling the user to switch Claude to Fable before planning begins.
- Fable's phase is for investigation and a detailed implementation plan unless the user explicitly authorizes code changes.
- Codex reviews the Fable plan before implementation starts.
- At the end of Fable's planning phase, `tasks.md` must explicitly tell the user to switch Claude back with `/model` and select Opus for implementation.
- Model switching is a visible user action; agents must not imply that it happened automatically.

## Shared Task File

The shared coordination file is:

`tasks.md`

Treat `tasks.md` as the source of truth for the current task.

### Standing `go` instruction

When the user tells Claude `go`, Claude must:

1. Read `tasks.md` completely before taking action.
2. Inspect the relevant repository code, tests, and any plan referenced by `tasks.md`.
3. Understand the objective, requirements, acceptance criteria, constraints, and assigned implementation phase.
4. Implement only the current task, run proportionate verification, and update the Claude-owned implementation sections of `tasks.md`.
5. Stop and report a material ambiguity or blocker rather than guessing at product, security, privacy, or data-migration decisions.

The command `go` does not override model-switch instructions. If `tasks.md` says to switch with `/model` before proceeding, Claude must follow that phase boundary.

### HerdR automatic handoff

- The ConsensusHealth HerdR agents are named `consensus-codex` and `consensus-claude`.
- After Codex has replaced and verified `tasks.md`, Codex should normally dispatch the task directly with:

  ```bash
  herdr agent prompt consensus-claude "go"
  ```

- Codex must not dispatch application implementation while it is still editing the same checkout. Finish the task brief and stop making overlapping application-code changes before prompting Claude.
- For an important task requiring Fable, Codex must first write the `/model` phase instruction and wait for the user to perform the visible model switch. After the correct model is selected, Codex may use HerdR to send `go`. The same rule applies when switching back to Opus for implementation.
- When Claude finishes its assigned phase, it must update `tasks.md`, set `Implementation Status` to `READY FOR CODEX REVIEW`, ensure its implementation report and verification results are complete, and then run:

  ```bash
  herdr agent prompt consensus-codex "check"
  ```

- Claude should send the HerdR review prompt only after all file writes and test commands have completed. The prompt is the presentation/handoff to Codex; `tasks.md` and the Git diff remain the authoritative evidence.
- If HerdR prompting fails, Claude must report the failure visibly so the user can send `check` manually.
- Codex may inspect live agent state with `herdr agent list`, wait with `herdr agent wait`, and read the agent transcript when needed. A lifecycle state alone is not proof that implementation succeeded.

### Task-file hygiene

- Whenever a new task begins, Codex must replace the previous contents of `tasks.md` with the new task; never append a new task beneath completed or stale instructions.
- Codex may first empty the file or overwrite it directly, but the saved result must describe only the single current task and any current approved-plan reference.
- Before handing work to Claude, Codex must verify that no requirements, implementation reports, review findings, or model-switch instructions from an earlier task remain.
- Historical task context belongs in Git history or a dedicated plan/document, not in the active `tasks.md`.

### Codex owns

- Objective
- Requirements
- Acceptance Criteria
- Constraints
- Relevant Context
- Review Status
- Review Findings

### Claude owns

- Implementation Status
- Implementation Report

Claude must not redefine requirements or acceptance criteria without Codex approval.

## Standard Workflow

### Minor task

1. User gives task to Codex.
2. Codex inspects the code.
3. Codex implements the change directly.
4. Codex runs relevant checks.
5. User tests.
6. User decides whether to merge.

### Normal substantial task

1. User gives task to Codex.
2. Codex defines requirements and acceptance criteria.
3. Codex writes/updates `tasks.md`.
4. Claude Opus reads `tasks.md`.
5. Opus implements on a feature branch.
6. Opus updates the implementation report.
7. Codex reviews the actual Git diff and tests.
8. Codex marks `APPROVED` or `REVISIONS REQUIRED`.
9. Opus fixes revisions if required.
10. User tests and approves merge.

### Complex architectural task

1. User gives task to Codex.
2. Codex defines requirements and acceptance criteria.
3. Codex recommends Fable.
4. User switches Claude to Fable.
5. Fable creates `/plans/<feature-name>.md`.
6. Codex reviews the plan.
7. Fable revises if needed.
8. User switches Claude back to Opus.
9. Opus implements the approved plan.
10. Codex reviews the final implementation.
11. User tests and approves merge.

## Git Rules

- Prefer feature branches for implementation work.
- Never merge to `main` without explicit user approval.
- The user is the final tester and merge authority.
- Preserve unrelated behavior.
- Avoid unnecessary rewrites.
- Keep changes as small and maintainable as reasonably possible.
- Do not push destructive changes.
- Do not treat passing tests as automatic approval.

### Standing `check` instruction

When the user says `check` after Claude has worked on a task, that is a standing instruction for Codex to:

1. Read the current task requirements and Claude's implementation report.
2. Inspect Claude's actual Git diff and repository status.
3. Run checks proportionate to the risk, including relevant tests, linting, and builds.
4. Review correctness, security, regressions, scope, and compliance with any approved Fable plan.
5. If satisfied, give `APPROVE`, commit the approved scoped changes when needed, integrate them into `main`, and push `main` to its configured remote.
6. If anything is wrong or verification fails, give `REVISIONS REQUIRED`, do not push, and write precise corrective instructions for Claude.

The word `check` provides standing authorization for the commit/integration/push in step 5 only after Codex's review passes. It does not authorize force-pushing, bypassing protections, discarding unrelated work, deploying, or including unrelated changes. If authentication, branch protection, merge conflicts, or a dirty overlapping worktree prevents a safe push, Codex must stop and report the blocker.

### Standing push authorization after implementation

- When the user directly asks Codex to implement or address a change, Codex may commit the scoped change and push it to `main` without waiting for a separate `check`, but only after Codex is satisfied with its review and proportionate verification.
- The same authorization applies after Claude implements a task and Codex completes a successful review, whether that review was triggered through HerdR or directly by the user.
- Codex must not push when tests or review reveal a task-specific failure, when unrelated changes cannot be cleanly excluded, or when safe integration is blocked.
- This standing authorization does not include deployment, force-pushing, bypassing branch protection, or silently committing unrelated user files.

## Review Standard

When Codex reviews implementation, it should check:

- correctness
- regressions
- architectural consistency
- security issues
- unnecessary complexity
- missed edge cases
- performance implications
- test coverage
- scope creep
- compliance with `tasks.md`
- compliance with any approved Fable plan

Codex must give one of two clear outcomes:

`APPROVE`

or

`REVISIONS REQUIRED`

If revisions are required, Codex should give precise, actionable instructions.

## Project-Specific Context

### Project purpose

ConsensusHealth (public site: [consensus.health](https://consensus.health)) lets X (Twitter) users sign in and record a public stance on Bitcoin proposals (BIPs), then visualizes the community's positions as an interactive "galaxy" graph. Users log in via X OAuth, choose a stance on one or more proposals (e.g. BIP54, BIP110, BIP448, BIP460), optionally attach an explanation URL, and see themselves plotted alongside everyone else's stance history.

### Architecture overview

- **Frontend**: React 19 + Vite (`src/`), plain CSS (`App.css`, `index.css`), canvas/D3-force (`d3-force`) driven "galaxy" visualizations rather than a charting library.
- **Backend**: Node/Express 5 + TypeScript (`server/src/`), run via `tsx` in dev and compiled with `tsc` for production (`server/dist/`).
- **Database**: Postgres, accessed via `pg`. Schema/catalog/backfill migrations run on server boot inside `ensureProposalSchema(pool)`, guarded by a transaction-scoped `pg_advisory_xact_lock` so concurrent instance boots serialize safely (see `docs/consensus-universe.md`).
- **Auth**: X OAuth (`X_CLIENT_ID`/`X_CLIENT_SECRET`/`X_REDIRECT_URI`), signed session cookies (`SESSION_SECRET`).
- **Data model**: `user_proposal_stances` / `user_proposal_stance_history` are the canonical, authoritative tables for every proposal including BIP110. The older `community_users.stance`, `stance_history`, `stance_events` tables are BIP110-only **compatibility mirrors** — dual-written in the same transaction as the canonical write, and never overwritten by an older value. New code must read from the canonical proposal tables, not the legacy mirrors.
- In production this ships as a **single Node service**: it serves `/api/*`, `/auth/*`, `/dev/*` API routes and also serves the built static frontend (`dist/`) plus SPA fallback for non-API routes.

### Important directories

- `src/` — React frontend; `src/components/` (UI + galaxy visualizations), `src/utils/` (pure logic, most heavily unit-tested), `src/api/` (fetch wrappers to backend), `src/config/` (proposal themes, layout constants), `src/features/consensusUniverse/`.
- `server/src/` — Express backend; route handlers and domain logic live as sibling `*.ts` files (e.g. `proposals.ts`, `stanceHistory.ts`, `accountDeletion.ts`) each generally paired with a co-located `*.test.ts`; `server/src/security/` holds CORS, rate limiting, env validation, client IP, and test-mode gating; `server/src/integration/` holds Postgres-backed integration tests.
- `docs/` — `consensus-universe.md` (data model/migration internals), `launch-runbook.md` (ops/env/rollback), `launch-smoke-checklist.md` (manual post-deploy checklist).
- `scripts/` — operational/CI scripts: secret scanning, launch linting, static smoke test, unit/integration test runners, avatar/bio backfills, DB pruning.
- `e2e/` — Playwright end-to-end specs run against a real built frontend + real API + Postgres (not mocked, aside from X OAuth).
- `plans/` — where Claude Fable writes `/plans/<feature-name>.md` architecture/implementation plans.

### Deployment model

- Single Render web service. Build command: `npm install && npm run build` (builds frontend to `dist/` and backend to `server/dist/`). Start command: `npm run start` (`node server/dist/index.js`).
- Canonical production origin: `https://consensus.health`.
- Config is environment-variable driven; see `server/env.example` for the full list. Production startup requires database credentials, a non-placeholder `SESSION_SECRET`, at least one valid HTTPS `APP_URL`/`APP_ORIGIN`, and X client credentials. Deployments should also set `FRONTEND_BASE_URL`, `X_REDIRECT_URI`, and a valid `CONTACT_EMAIL`; the validator currently warns rather than exits for a short non-placeholder session secret or a missing/invalid contact email.
- Health/readiness: `GET /api/health` (liveness) and `GET /api/ready` (Postgres check, 503 when not ready) — see `docs/launch-runbook.md` for uptime monitoring guidance.
- Two proxy trust modes: `TRUST_PROXY_MODE=render_direct` (default) or `cloudflare_origin_lock` (requires `CF_ORIGIN_SECRET` + a Cloudflare-set verify header; origin 403s direct traffic other than health checks).
- E2E/mock-OAuth env flags (`X_OAUTH_MOCK`, `CONSENSUSHEALTH_E2E`, `E2E_SERVE_DIST`, `FORCE_LISTEN`, `X_OAUTH_MOCK_*`) are only honored when `NODE_ENV=test`; the server refuses to start in production if any are set.

### Testing commands

- `npm run lint` — ESLint (flat config, `eslint.config.js`; React hooks + refresh plugins; `src/App.jsx` is exempt from the refresh-only-export rule).
- `npm test` — unit tests (`scripts/run-unit-tests.mjs`); note CI installs a Chromium browser first because `oauthPopupCsp.test.ts` launches it.
- `npm run test:integration` — Postgres-backed integration tests (`scripts/require-integration-passes.mjs`); needs `TEST_DATABASE_URL` pointed at a disposable database, never production/shared dev data.
- `npm run test:e2e` — Playwright, real API + real built `dist/` frontend + Postgres, X OAuth mocked via `X_OAUTH_MOCK=1`. CI fails the job on any skipped test.
- `npm run build` — `build:web` (Vite) + `build:server` (`tsc -p server/tsconfig.json`).
- `npm run check:secrets` / `npm run lint:launch` / `npm run smoke:static` — secret scanning, launch/security surface lint, and static-path smoke check; all run in CI (`.github/workflows/ci.yml`) alongside `npm audit --omit=dev`.
- CI (`ubuntu-latest`, Postgres 16 service) runs, in order: secret scan → lint:launch → unit tests → integration tests → build → static smoke → `npm audit --omit=dev` → Playwright launch smoke.

### Coding conventions

- Frontend files are `.jsx`/`.js`; newer frontend utilities and most backend files are TypeScript (`.ts`/`.tsx`); the codebase is in a partial JS→TS migration, so match the existing file's language rather than converting wholesale.
- Tests are co-located next to the code they cover (`foo.ts` + `foo.test.ts`), not in a separate `__tests__` tree.
- Proposal theming must use an approved theme key from `src/config/proposalThemes.ts` (`nebula-red` | `nebula-cyan` | `nebula-violet` | `nebula-yellow`, or a newly validated key) — never apply raw DB-sourced CSS.
- `no-unused-vars` is an ESLint error except for identifiers matching `^[A-Z_]`.

### Important constraints

- Never read BIP110 stances from the legacy `community_users`/`stance_history`/`stance_events` tables for user-visible logic — treat them as write-only mirrors. Reads should go through the canonical `user_proposal_stances`/`user_proposal_stance_history` tables (see `docs/consensus-universe.md`).
- Adding a new proposal/galaxy is done via a seed entry in `server/src/proposalCatalog.ts` (`PROPOSAL_SEEDS`) plus, if needed, a theme in `src/config/proposalThemes.ts`; it should not normally require new proposal-specific API routes. Only BIP110 unions legacy seed data — new galaxies start empty.
- Dropping `user_proposal_*` tables is destructive and irreversible for recorded stances on non-BIP110 proposals (and for canonical BIP110 history); do not do this after production data has been collected. Prefer testing schema/rollback changes on a copied database first.
- `TEST_DATABASE_URL` (and any DB test fixture setup) must never point at production or shared development data.
- Stray root file `et --hard fe15074` present in the repo is very likely leftover from an errant `git reset --hard fe15074` redirected to a file — flag it to the user rather than silently deleting it, since it wasn't intentionally created by this task.

### Security considerations

- Session cookies are signed with `SESSION_SECRET`, which must be a strong random value ≥32 characters in production — never a placeholder.
- CORS is restricted via `APP_ORIGIN`; client IP trust depends on `TRUST_PROXY_MODE` (`render_direct` vs `cloudflare_origin_lock` with `CF_ORIGIN_SECRET`) — see `server/src/security/`.
- Rate limits (in-memory, per instance): general `/api/*` 120/min, auth 20/15min, stance/explanation writes 30/15min, account deletion 10/15min (`server/src/security/rateLimits.ts`).
- Account deletion is `POST /api/me/delete` with `{ "confirm_handle": "<handle>" }`, authenticated, and must match the signed-in handle.
- `scripts/check-secrets.mjs` (secret/artifact scan) and `scripts/lint-launch.mjs` (launch/security surface lint) run in CI and should stay green.
- Mock-auth/E2E env flags must never be set in production; the server enforces this at startup (`server/src/security/envValidation.ts`, `server/src/security/testMode.ts`).

### Branch/deployment rules

- Default branch is `main`; git remote is `git@github.com:zndtoshi/ConsensusHealth.git`.
- Per the Git Rules above: use feature branches for implementation work, never merge to `main` without explicit user approval, and don't push destructive changes.
- CI (GitHub Actions, `.github/workflows/ci.yml`) runs on push to `main`/`master` and on pull requests.

### Anything agents must understand before making changes

- This is a real production service handling OAuth-authenticated user data and public stance records tied to real X accounts — treat schema/migration changes and anything touching the legacy/canonical stance mirroring as high-risk and prefer Fable-level planning for them per the Standard Workflow above.
- `docs/consensus-universe.md` is the authoritative internal reference for the proposal/galaxy data model and must be consulted (and kept in sync) for any change touching stances, proposals, or migrations.
- Read `docs/launch-runbook.md` and `docs/launch-smoke-checklist.md` before touching deploy-affecting config, health/readiness endpoints, or env var handling.
