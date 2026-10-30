import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseClient } from '../../../../src/shared/db/database.js';
import { migrateToLatest } from '../../../../src/shared/db/migrate.js';

const CONTAINER_START_MS = 120_000;

const FROZEN = [
  '101_20261016120000_core',
  '102_20261016120100_evidence',
  '103_20261016120200_carbon',
  '104_20261016120300_audit_ops',
  '105_20261016120400_security',
  '106_20261018120000_relayer_sent_reclaim',
  '107_20261018130000_reports_audit',
  '108_20261018140000_set_price_job',
  '109_20261018150000_demo_reset',
];

describe('migrations — ADR-019, data-spec §5.2 and §6.2', () => {
  let postgres: StartedPostgreSqlContainer;
  let database: DatabaseClient;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .start();
    database = createDatabase({
      url: postgres.getConnectionUri(),
      poolMax: 2,
      timeoutMs: 30_000,
      onConnectionError: () => undefined,
    });
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await database.destroy();
    await postgres.stop();
  });

  it(
    'an empty PostgreSQL 17 applies the bootstrap, the nine frozen files and the additions, in that order',
    async () => {
      const results = await migrateToLatest(database, 'migrations');

      expect(results.map(({ migrationName, status }) => [migrationName, status])).toEqual(
        ['000_bootstrap', ...FROZEN, '200_rewrite_additions', '201_faucet_jobs'].map((name) => [
          name,
          'Success',
        ]),
      );
    },
    CONTAINER_START_MS,
  );

  it('a second run applies nothing', async () => {
    expect(await migrateToLatest(database, 'migrations')).toEqual([]);
  });

  it('the additions are in place: slot_tags, the new columns, the challenge exclusion and the closed-audit triggers', async () => {
    const { rows } = await sql<{ found: string }>`
      select 'table:' || table_name as found from information_schema.tables
        where table_schema = 'public' and table_name = 'slot_tags'
      union all
      select 'column:' || table_name || '.' || column_name from information_schema.columns
        where table_schema = 'public' and (table_name, column_name) in
          (('audit_sessions', 'report_notes'), ('carbon_batches', 'issued_at'), ('submissions', 'precheck_results'))
      union all
      select 'constraint:' || conname from pg_constraint
        where conname in ('challenges_one_open_per_tree', 'audit_sessions_closed_have_notes', 'devices_label_required')
      union all
      select 'trigger:' || tgname from pg_trigger
        where tgname in ('audit_sessions_frozen_after_close', 'audit_samples_frozen_after_close')
      order by 1`.execute(database);

    expect(rows.map(({ found }) => found)).toEqual([
      'column:audit_sessions.report_notes',
      'column:carbon_batches.issued_at',
      'column:submissions.precheck_results',
      'constraint:audit_sessions_closed_have_notes',
      'constraint:challenges_one_open_per_tree',
      'constraint:devices_label_required',
      'table:slot_tags',
      'trigger:audit_samples_frozen_after_close',
      'trigger:audit_sessions_frozen_after_close',
    ]);
  });
});
