#!/usr/bin/env node
/**
 * Print a reproducible disposable Postgres recipe for local integration + e2e.
 * Does not start Docker itself (Docker may be unavailable on the host).
 */
const url = "postgresql://postgres:postgres@127.0.0.1:5432/consensushealth_test";

console.log(`
Disposable Postgres for Consensus Health launch tests
====================================================

Docker (recommended):
  docker run --rm -d --name ch-pg-test \\
    -e POSTGRES_PASSWORD=postgres \\
    -e POSTGRES_DB=consensushealth_test \\
    -p 5432:5432 postgres:16

Then (PowerShell):
  $env:TEST_DATABASE_URL = "${url}"
  npm run test:integration
  npm run test:e2e

Or (bash):
  export TEST_DATABASE_URL="${url}"
  npm run test:integration
  npm run test:e2e

CI uses the GitHub Actions Postgres service with the same shape of URL.
Refuse production/shared-looking URLs (integration helpers enforce this).
`);
