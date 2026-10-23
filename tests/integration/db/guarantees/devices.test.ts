import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDomainError } from '../../../../src/shared/db/constraints.js';
import type { DatabaseClient } from '../../../../src/shared/db/database.js';
import { migrateToLatest, migrateUpTo } from '../../../../src/shared/db/migrate.js';
import { DomainError } from '../../../../src/shared/errors.js';
import { aPlantedTree, PLANTER_ID } from '../../../fixtures/mirror.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

const LAST_FROZEN = '109_20261018150000_demo_reset';
// A public P-256 key (no `d`), as public_p256_key_only requires; the thumbprint differs per device.
const PUBLIC_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};

const aDevice = (database: DatabaseClient, thumbprint: string, label: string | null) =>
  sql`insert into public.devices (profile_id, public_key_jwk, thumbprint, label)
      values (${PLANTER_ID}, ${JSON.stringify(PUBLIC_KEY)}::jsonb, ${thumbprint}, ${label})`.execute(
    database,
  );

const thumbprint = (letter: string): string => letter.repeat(43);

describe('FR-120 a device has a label, on new rows only — data-spec §6.2 devices_label_required NOT VALID', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    // A device written before the constraint existed, then the additions.
    test = await startMigratedDatabase(2, async (database) => {
      await migrateUpTo(database, 'migrations', LAST_FROZEN);
      await aPlantedTree(database);
      await aDevice(database, thumbprint('A'), null);
      await migrateToLatest(database, 'migrations');
    });
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  it('a device registered before the constraint keeps its empty label', async () => {
    const { rows } = await sql<{ label: string | null }>`
      select label from public.devices where thumbprint = ${thumbprint('A')}`.execute(
      test.database,
    );

    expect(rows).toEqual([{ label: null }]);
  });

  it('a new device without a label is refused and maps to validation_error', async () => {
    const error = await aDevice(test.database, thumbprint('B'), null).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: '23514', constraint: 'devices_label_required' });
    expect(toDomainError(error)).toEqual(
      new DomainError('validation_error', [{ path: 'label', message: 'Required' }]),
    );
  });

  it('a new device with a label is accepted', async () => {
    await expect(
      aDevice(test.database, thumbprint('C'), 'Pixel 8 · field phone'),
    ).resolves.toBeDefined();
  });
});
