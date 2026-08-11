# Consensus Universe

Internal notes for the multi-proposal (galaxy) data model and migrations.

## Canonical data model

- `user_proposal_stances` and `user_proposal_stance_history` are **authoritative** for every BIP, including BIP110.
- `community_users.stance`, `stance_history`, and `stance_events` are BIP110 **compatibility mirrors only**.
- After migration `2026-07-consensus-universe-v1`, user-visible reads must not use legacy stance columns/tables.
- Dual-write: every BIP110 stance change updates canonical tables first, then mirrors legacy tables in the **same transaction**. If the mirror fails, the whole write rolls back.
- Legacy mirrors may be removed later once all consumers and operational scripts use proposal tables only.

## Migration behavior

- `ensureProposalSchema(pool)` uses a dedicated pool client, then:

  ```
  BEGIN
  SELECT pg_advisory_xact_lock(<stable app key>)
  ... schema / catalog / backfill ...
  COMMIT
  ```

- The lock is **transaction-scoped** (`pg_advisory_xact_lock`) so it cannot remain held after commit/rollback.
- Concurrent Render instance boots serialize migration execution safely.
- Version is recorded in `schema_migrations` only after every required step succeeds.
- Catalog sync (`proposals` upsert) is idempotent and runs on every boot.
- One-time BIP110 stance/history backfill runs only when the version is not yet recorded.
- Stance backfill uses `ON CONFLICT DO NOTHING` and never overwrites a newer canonical stance with an older legacy value.
- History backfill stores `legacy_stance_history_id` and uses `ON CONFLICT DO NOTHING` against a unique index on that column.
- Failure → `ROLLBACK` + client release + rethrow. No partial commit of that migration transaction.
- Logs (no secrets): migration started / lock acquired / migration completed / migration failed.

## History uniqueness

- Preferred key: `legacy_stance_history_id` (stable PK from legacy `stance_history.id`).
- Unique index on `legacy_stance_history_id` (NULLs allowed for runtime events so genuine repeated transitions at different times remain valid).
- Duplicate cleanup keeps the smallest `id` before creating the unique index.

## BIP110 seed accounts

- Seed accounts are associated with BIP110 at the **query layer** via a clearly scoped `UNION` for graph/CSV.
- Seeds are **not** copied into BIP54/BIP448 and do not create duplicate `community_users` rows.

## Adding another proposal

1. Add a seed entry in `server/src/proposalCatalog.ts` (`PROPOSAL_SEEDS`) with `adminOnly`, `themeKey`, copy, and display order.
2. If needed, add an approved theme in `src/config/proposalThemes.ts` (`nebula-red` | `nebula-cyan` | `nebula-violet` | `nebula-yellow` or a new validated key). Never apply raw DB CSS.
3. Deploy; boot migration syncs the `proposals` table. No new proposal-specific API routes should normally be required.
4. Access policy comes from `admin_only` / `enabled` on the proposal row (seed sync re-applies known seed values on boot).
5. Confirm seed policy: only BIP110 unions static seed JSON; new galaxies start empty (no seeds).

Frontend navigation, adjacent wrapping, distant galaxies, header labels, URL parsing, and themes derive from `/api/proposals` (accessible catalog). Invalid URLs fall back to BIP110 / first accessible proposal.

## Staging and rollback

- Prefer a **copied database** on a temporary Render service before production.
- Safe code rollback: redeploy previous commit / check out `main`. Does not destroy recorded positions.
- Destructive data rollback: dropping `user_proposal_*` tables **destroys** BIP54/BIP448 positions and canonical BIP110 history. Do **not** drop after collecting production positions.

## Local integration tests

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/consensus_test npm run test:integration
```

Do not point `TEST_DATABASE_URL` at production or shared development data.
