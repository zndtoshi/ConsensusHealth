/**
 * Safety-guard unit checks for integration helpers (no live DB required).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTestDatabaseUrl } from "./helpers.js";

test("assertSafeTestDatabaseUrl allows localhost and 127.0.0.1", () => {
  assert.doesNotThrow(() =>
    assertSafeTestDatabaseUrl("postgresql://postgres:postgres@localhost:5432/consensushealth")
  );
  assert.doesNotThrow(() =>
    assertSafeTestDatabaseUrl("postgres://u:p@127.0.0.1:5432/anything")
  );
});

test("assertSafeTestDatabaseUrl allows remote URLs with test/ci/tmp markers", () => {
  assert.doesNotThrow(() =>
    assertSafeTestDatabaseUrl("postgresql://u:p@db.example.com:5432/consensushealth_test")
  );
  assert.doesNotThrow(() =>
    assertSafeTestDatabaseUrl("postgresql://u:p@ci-pg.example.com:5432/app")
  );
  assert.doesNotThrow(() =>
    assertSafeTestDatabaseUrl("postgresql://u:p@db.example.com:5432/tmp_scratch")
  );
});

test("assertSafeTestDatabaseUrl refuses production-named and known prod hosts", () => {
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://u:p@db.example.com:5432/production"),
    /refuse|production|test\/ci\/tmp/i
  );
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://u:p@prod-db.example.com:5432/app"),
    /refuse|production|test\/ci\/tmp/i
  );
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://u:p@db.consensus.health:5432/app"),
    /refuse|production|shared/i
  );
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://u:p@shared.example.com:5432/consensushealth"),
    /localhost|test\/ci\/tmp/i
  );
});

test("assertSafeTestDatabaseUrl refuses empty / non-postgres", () => {
  assert.throws(() => assertSafeTestDatabaseUrl(""), /empty/i);
  assert.throws(() => assertSafeTestDatabaseUrl("mysql://localhost/test"), /postgres/i);
});
