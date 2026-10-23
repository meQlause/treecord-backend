import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueue, type EnqueueInput } from '../../../../src/features/jobs/jobs.service.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { aProfile, CAMPAIGN } from '../../../fixtures/mirror.js';

const PLANTER_WALLET = '0x4b9e2f1a7c3d05e6f8a91b2c3d4e5f6a7b8c9d0e';

let test: TestDatabase;
let sari: string;
let dewi: string;
let raka: string;
let keys = 0;

// A fresh client key per test, so tests never share a job.
const nextKey = (): string => {
  keys += 1;

  return `d06-claim-${keys}`;
};

const claim = (createdBy: string, idempotencyKey: string | null): EnqueueInput => ({
  kind: 'claim',
  payload: { campaign: CAMPAIGN, planter: PLANTER_WALLET, count: 2 },
  createdBy,
  idempotencyKey,
});

const run = (input: EnqueueInput) =>
  test.database.transaction().execute((trx) => enqueue(trx, input));

beforeAll(async () => {
  test = await startMigratedDatabase();
  sari = await aProfile(test.database, 'planter', 'did:privy:cm2sari0000000000000000');
  dewi = await aProfile(test.database, 'planter', 'did:privy:cm2dewi0000000000000000');
  raka = await aProfile(test.database, 'operator', 'did:privy:cm2raka0000000000000000');
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/jobs.md §3, ADR-009, FR-028.
describe('enqueue: create, replay, re-arm', () => {
  it('creates a pending job with its key and creator', async () => {
    const key = nextKey();
    const { job, outcome } = await run(claim(sari, key));

    expect(outcome).toBe('created');
    expect(job).toMatchObject({
      kind: 'claim',
      status: 'pending',
      attempts: 0,
      idempotency_key: key,
      created_by_profile_id: sari,
    });
  });

  it('the same key from the same caller and action replays the original job and writes nothing', async () => {
    const key = nextKey();
    const first = await run(claim(sari, key));
    const again = await run({
      ...claim(sari, key),
      payload: { ...claim(sari, key).payload, count: 3 },
    });

    expect(again.outcome).toBe('replayed');
    expect(again.job.id).toBe(first.job.id);
    // the original wins: a replay never compares or rewrites the payload
    expect(again.job.payload).toEqual(first.job.payload);
  });

  it('re-arms a failed job: same id, pending, attempts 0, its tx hash and last error kept (R5)', async () => {
    const key = nextKey();
    const { job } = await run(claim(sari, key));
    const txHash = `0x${'9c'.repeat(32)}`;

    await sql`update public.relayer_jobs set status = 'failed', attempts = 5, tx_hash = ${txHash},
      last_error = 'Worker failure', next_attempt_at = now() + interval '1 hour' where id = ${job.id}`.execute(
      test.database,
    );

    const rearmed = await run({
      ...claim(sari, key),
      payload: { ...claim(sari, key).payload, count: 1 },
    });

    expect(rearmed.outcome).toBe('rearmed');
    expect(rearmed.job).toMatchObject({
      id: job.id,
      status: 'pending',
      attempts: 0,
      tx_hash: txHash,
      last_error: 'Worker failure',
      locked_at: null,
      locked_by: null,
      payload: { count: 1 },
    });
    expect(rearmed.job.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('enqueue: conflicts, transactions and bad input', () => {
  it.each([
    ['another caller', () => dewi, 'claim'],
    ['another action', () => sari, 'anchor_assign'],
  ] as const)(
    'the same client key from %s answers 409 idempotency_key_reused',
    async (_case, caller, kind) => {
      const key = nextKey();

      await run(claim(sari, key));

      await expect(run({ ...claim(caller(), key), kind })).rejects.toMatchObject({
        code: 'idempotency_key_reused',
      });
    },
  );

  it('a derived key names its target, so another operator re-runs it (R4)', async () => {
    const key = `resolve_flag:${nextKey()}`;
    const input: EnqueueInput = {
      kind: 'resolve_flag',
      payload: { treeId: '3091', uphold: false, noteHash: `0x${'5e'.repeat(32)}` },
      createdBy: raka,
      idempotencyKey: key,
    };
    const first = await run(input);

    expect((await run({ ...input, createdBy: sari })).job.id).toBe(first.job.id);
  });

  it('runs on the caller transaction: a rollback leaves no job (R1)', async () => {
    const key = nextKey();

    await expect(
      test.database.transaction().execute(async (trx) => {
        await enqueue(trx, claim(sari, key));
        throw new Error('the caller failed after enqueueing');
      }),
    ).rejects.toThrow('the caller failed');

    expect((await run(claim(sari, key))).outcome).toBe('created');
  });

  it('two concurrent requests with one key make one job (R3)', async () => {
    const key = nextKey();
    const results = await Promise.all([run(claim(sari, key)), run(claim(sari, key))]);

    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'replayed']);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
  });

  it('a payload its kind does not accept is a server bug, never a domain error (R6)', async () => {
    const input = { ...claim(sari, nextKey()), payload: { campaign: 'not-an-address' } };

    await expect(run(input)).rejects.not.toHaveProperty('code');
  });

  it('a job without a key is always created anew', async () => {
    const first = await run(claim(sari, null));
    const second = await run(claim(sari, null));

    expect(second.outcome).toBe('created');
    expect(second.job.id).not.toBe(first.job.id);
  });
});
