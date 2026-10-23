import { randomBytes } from 'node:crypto';
import express from 'express';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toDomainError } from '../../../../src/shared/db/constraints.js';
import type { DatabaseClient } from '../../../../src/shared/db/database.js';
import { DomainError } from '../../../../src/shared/errors.js';
import { errorHandler } from '../../../../src/shared/http/error-handler.js';
import { requestId } from '../../../../src/shared/http/request-id.js';
import {
  aPlantedTree,
  AUDITOR_ID,
  CAMPAIGN,
  PLANTER_ID,
  TREE_ID,
} from '../../../fixtures/mirror.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';

const KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};
const hex64 = (): string => randomBytes(32).toString('hex');
const hash32 = (): string => `0x${hex64()}`;
const privyId = (): string => `did:privy:${hex64().slice(0, 12)}`;
const PLANTER_WALLET = `0x${'a'.repeat(40)}`;
const thumbprint = (): string => randomBytes(32).toString('base64url');

const refusal = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => undefined,
    (error: unknown) => error,
  );

const accepted = (database: DatabaseClient, kind: 'ALIVE' | 'PLANTED', video = hex64()) =>
  kind === 'ALIVE'
    ? sql`insert into public.submissions (profile_id, campaign_address, tree_id, kind, milestone, video_sha256, status)
          values (${PLANTER_ID}, ${CAMPAIGN}, ${TREE_ID}, 'ALIVE', 4, ${video}, 'onchain')`.execute(
        database,
      )
    : sql`insert into public.submissions (profile_id, campaign_address, slot_id, kind, milestone, video_sha256, status)
          values (${PLANTER_ID}, ${CAMPAIGN}, 1, 'PLANTED', 0, ${video}, 'onchain')`.execute(
        database,
      );

const aDevice = (database: DatabaseClient, print = thumbprint(), key: object = KEY) =>
  sql`insert into public.devices (profile_id, public_key_jwk, thumbprint, label)
      values (${PLANTER_ID}, ${JSON.stringify(key)}::jsonb, ${print}, 'Pixel 8')`.execute(database);

const aProfile = (database: DatabaseClient, wallet: string, role = 'donor') =>
  sql`insert into public.profiles (privy_user_id, wallet_address, role)
      values (${privyId()}, ${wallet}, ${role}::public.user_role)`.execute(database);

// Each case causes the violation for real; `expected` is the domain error of error-handling §2.1.
const MAPPED: Array<[string, (database: DatabaseClient) => Promise<unknown>, DomainError]> = [
  [
    'a second accepted ALIVE for one tree and milestone',
    async (database) => {
      await accepted(database, 'ALIVE');

      return accepted(database, 'ALIVE');
    },
    new DomainError('precheck_failed', { reasons: ['milestone_already_done'] }),
  ],
  [
    'a second accepted PLANTED for one slot',
    async (database) => {
      await accepted(database, 'PLANTED');

      return accepted(database, 'PLANTED');
    },
    new DomainError('precheck_failed', { reasons: ['slot_already_planted'] }),
  ],
  [
    'a video submitted twice (submissions_video_sha256_key)',
    async (database) => {
      const video = hex64();

      await sql`insert into public.submissions (profile_id, campaign_address, tree_id, kind, milestone, video_sha256)
                values (${PLANTER_ID}, ${CAMPAIGN}, ${TREE_ID}, 'ALIVE', 5, ${video})`.execute(
        database,
      );

      return sql`insert into public.submissions (profile_id, campaign_address, tree_id, kind, milestone, video_sha256)
                 values (${PLANTER_ID}, ${CAMPAIGN}, ${TREE_ID}, 'ALIVE', 3, ${video})`.execute(
        database,
      );
    },
    new DomainError('precheck_failed', { reasons: ['duplicate_video'] }),
  ],
  [
    'a device key registered twice (devices_thumbprint_key)',
    async (database) => {
      const print = thumbprint();

      await aDevice(database, print);

      return aDevice(database, print);
    },
    new DomainError('device_already_registered'),
  ],
  [
    'a fourth active device (trigger message device_limit_reached)',
    async (database) => {
      await sql`update public.devices set revoked_at = now() where profile_id = ${PLANTER_ID}`.execute(
        database,
      );
      await aDevice(database);
      await aDevice(database);
      await aDevice(database);

      return aDevice(database);
    },
    new DomainError('device_limit_reached'),
  ],
  [
    'a wallet that belongs to another profile (profiles_wallet_address_key)',
    async (database) => aProfile(database, `0x${'a'.repeat(40)}`),
    new DomainError('wallet_already_linked'),
  ],
  [
    'a planter without the carbon-rights agreement (planters_accept_carbon_agreement)',
    async (database) => aProfile(database, `0x${'d'.repeat(40)}`, 'planter'),
    new DomainError('agreement_required'),
  ],
  [
    'a private or non-P-256 device key (public_p256_key_only)',
    async (database) => {
      await sql`update public.devices set revoked_at = now() where profile_id = ${PLANTER_ID}`.execute(
        database,
      );

      return aDevice(database, thumbprint(), { ...KEY, crv: 'P-384' });
    },
    new DomainError('validation_error', [
      { path: 'publicKey', message: 'Must be a public P-256 key' },
    ]),
  ],
];

// error-handling §2.1: these are bugs, not user input — they stay a 500 internal_error.
const UNMAPPED: Array<[string, (database: DatabaseClient) => Promise<unknown>]> = [
  [
    'an attestation nonce used twice',
    async (database) => {
      await sql`insert into public.submissions (profile_id, campaign_address, tree_id, kind, milestone, video_sha256, attestation_nonce)
                values (${PLANTER_ID}, ${CAMPAIGN}, ${TREE_ID}, 'ALIVE', 1, ${hex64()}, '77')`.execute(
        database,
      );

      return sql`insert into public.submissions (profile_id, campaign_address, tree_id, kind, milestone, video_sha256, attestation_nonce)
                 values (${PLANTER_ID}, ${CAMPAIGN}, ${TREE_ID}, 'ALIVE', 2, ${hex64()}, '77')`.execute(
        database,
      );
    },
  ],
  [
    'an attestation job queued twice for one nonce (relayer_jobs_attestation_nonce_idx)',
    async (database) => {
      await sql`insert into public.relayer_jobs (kind, payload) values ('attestation', '{"nonce":"88"}'::jsonb)`.execute(
        database,
      );

      return sql`insert into public.relayer_jobs (kind, payload) values ('attestation', '{"nonce":"88"}'::jsonb)`.execute(
        database,
      );
    },
  ],
  [
    'two sampled trees in one position (audit_samples session_id, position)',
    async (database) => {
      const session = '868c029f-2a97-4721-b005-f66b88e3768b';

      await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
                values (${CAMPAIGN}, 2, 'open', 'claimed', ${PLANTER_WALLET})`.execute(database);
      await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash, latest_evidence_hash, planted_tx)
                values (3002, ${CAMPAIGN}, 2, ${PLANTER_WALLET}, now(), 'qqguw7p', ${hash32()}, ${hash32()})`.execute(
        database,
      );
      await sql`insert into public.audit_sessions (id, auditor_profile_id, campaign_address, seed, seed_block_number, seed_block_hash, sample_size)
                values (${session}, ${AUDITOR_ID}, ${CAMPAIGN}, ${hash32()}, 1, ${hash32()}, 2)`.execute(
        database,
      );
      await sql`insert into public.audit_samples (session_id, tree_id, position) values (${session}, ${TREE_ID}, 0)`.execute(
        database,
      );

      return sql`insert into public.audit_samples (session_id, tree_id, position) values (${session}, 3002, 0)`.execute(
        database,
      );
    },
  ],
  [
    'any other CHECK (a display name over 80 characters)',
    async (database) =>
      sql`update public.profiles set display_name = ${'x'.repeat(81)} where id = ${AUDITOR_ID}`.execute(
        database,
      ),
  ],
  [
    'a change to the append-only access log (reject_mutation, 42501)',
    async (database) => {
      await sql`insert into public.audit_access_log (profile_id, tree_id) values (${AUDITOR_ID}, ${TREE_ID})`.execute(
        database,
      );

      return sql`update public.audit_access_log set tree_id = ${TREE_ID}`.execute(database);
    },
  ],
];

describe('constraint violations become domain errors — docs/error-handling.md §2.1', () => {
  let test: TestDatabase;

  beforeAll(async () => {
    test = await startMigratedDatabase();
    await aPlantedTree(test.database);
  }, CONTAINER_START_MS);

  afterAll(async () => {
    await test.stop();
  });

  it.each(MAPPED)('%s', async (_name, violate, expected) => {
    expect(toDomainError(await refusal(violate(test.database)))).toEqual(expected);
  });

  it.each(UNMAPPED)(
    '%s stays unmapped, so it answers 500 internal_error',
    async (_name, violate) => {
      const error = await refusal(violate(test.database));

      expect(error).toBeInstanceOf(Error);
      expect(toDomainError(error)).toBeUndefined();
    },
  );

  it('a violation thrown from a route reaches the envelope with its status, never as a 500', async () => {
    const app = express()
      .use(requestId)
      .post('/wallet', async () => {
        await aProfile(test.database, `0x${'b'.repeat(40)}`);
      })
      .use(errorHandler({ logUnexpected: vi.fn() }));
    const response = await request(app).post('/wallet').expect(409);

    expect(response.body.error.code).toBe('wallet_already_linked');
  });
});
