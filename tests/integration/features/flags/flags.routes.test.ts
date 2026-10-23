import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy } from '../../../helpers/fake-privy.js';
import {
  ALEX,
  OPEN_FLAG_ID,
  RAKA,
  ROOTS,
  rootsThatStay,
  SARI,
} from '../../../fixtures/roots-that-stay.js';

const ALEX_WALLET = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';
const REASON = 'Tree condition needs an independent check.';
const REASON_HASH = '0xc29baac38459527c791a529ef47d1cc43d3734cef04e63520492971274b411cb';
const NOTE = 'Site visit confirmed the tree is alive and in place';
const NOTE_HASH = '0x37b4ff6197de0d488f0d4bb77772de390a6d69b3c5051dc8989f89bd4b5f5ec6';
const PENDING_FLAG_ID = '2a7d3b0f-5c8e-4f26-8b4d-9e3f6a1c8b72';
const UPHELD_FLAG_ID = '3b8e4c1a-6d9f-4a37-9c5e-0f4a7b2d9c83';
const UNKNOWN_ID = '7d5c9b8e-1f4a-4c2e-9a3b-6f0e2d1c4b5a';
// flags §2: the wallet that sent `TreeFlagged`, which can differ from the one that saved the text (identical reasons)
const EVENT_FLAGGER = '0x9a4c3e2b1d0f8e7a6c5b4d3e2f1a0b9c8d7e6f5a';
const OPENED_TX = '0x1ce442d81b6082fbb178e08bddf5191b38417d30caae1a738e505a3a3303314c';

let test: TestDatabase;
let api: TestApi;

const post = async (path: string, body: unknown, userId: string) =>
  request(api.app)
    .post(`/api/v1${path}`)
    .set(await api.signedIn(userId))
    .send(body as object);

const raise = (body: unknown, userId = ALEX) => post('/flags', body, userId);

const resolve = (flagId: string, body: unknown, userId = RAKA) =>
  post(`/operator/flags/${flagId}/resolve`, body, userId);

const flagRow = async (id: string) =>
  (
    await sql<{
      flagger_address: string;
      campaign_address: string;
      status: string;
      resolution_note: string | null;
      note_hash: string | null;
      resolved_by: string | null;
    }>`select f.flagger_address, f.campaign_address, f.status, f.resolution_note, f.note_hash,
        p.privy_user_id as resolved_by
      from public.flags f left join public.profiles p on p.id = f.resolved_by_profile_id
      where f.id = ${id}`.execute(test.database)
  ).rows[0];

const readFlag = async (treeId: string, flagId: string, userId = RAKA) =>
  request(api.app)
    .get(`/api/v1/operator/trees/${treeId}/flags/${flagId}`)
    .set(await api.signedIn(userId));

const jobsKeyed = async (flagId: string) => {
  const key = `resolve_flag:${flagId}`;

  return (
    await sql<{
      id: string;
      payload: object;
    }>`select id, payload from public.relayer_jobs
      where idempotency_key = ${key}`.execute(test.database)
  ).rows;
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await rootsThatStay(test.database);
  await sql`insert into public.flags (id, tree_id, campaign_address, flagger_address, reason_text, reason_hash, status)
    values (${PENDING_FLAG_ID}, 3104, ${ROOTS}, ${ALEX_WALLET}, 'Not on-chain yet', ${REASON_HASH}, 'pending'),
           (${UPHELD_FLAG_ID}, 3001, ${ROOTS}, ${ALEX_WALLET}, 'Already decided', ${REASON_HASH}, 'upheld')`.execute(
    test.database,
  );
  await sql`insert into public.tree_events (tree_id, kind, block_number, block_time, log_index, tx_hash, data)
    values (3091, 'flagged', 24118402, '2026-10-20T09:14:27Z', 0, ${OPENED_TX},
      ${JSON.stringify({ flagger: EVENT_FLAGGER, reasonHash: REASON_HASH, previousStatus: 'alive' })}::jsonb)`.execute(
    test.database,
  );
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/flags.md §1, FR-059, FR-060.
describe('POST /api/v1/flags', () => {
  it("saves Alex's reason on Alive tree 3001 as a pending flag: 201 with the §1 example", async () => {
    const response = await raise({ treeId: '3001', reasonText: REASON });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      flag: {
        id: expect.any(String),
        treeId: '3001',
        status: 'pending',
        reasonText: REASON,
        reasonHash: REASON_HASH,
        createdAt: expect.any(String),
      },
    });
    expect(await flagRow(response.body.flag.id)).toMatchObject({
      flagger_address: ALEX_WALLET,
      campaign_address: ROOTS,
      status: 'pending',
    });
  });

  it('the same text again, padded, answers 200 with the same flag (FR-060 acceptance 2)', async () => {
    const first = await raise({ treeId: '3001', reasonText: REASON });
    const again = await raise({ treeId: '3001', reasonText: `  ${REASON}\n` });

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ flag: first.body.flag, idempotent: true });
  });

  it('two identical requests at once leave one pending row (flags_one_pending_per_flagger_idx)', async () => {
    const reasonText = 'Leaves look scorched since the last check-in.';
    const responses = await Promise.all([
      raise({ treeId: '3104', reasonText }),
      raise({ treeId: '3104', reasonText }),
    ]);
    const rows = await sql<{ n: number }>`select count(*)::int as n from public.flags
      where tree_id = 3104 and reason_text = ${reasonText}`.execute(test.database);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('counts the reason in code points: 2,000 emoji are accepted, 2,001 are not', async () => {
    expect((await raise({ treeId: '3104', reasonText: '🌳'.repeat(2000) })).status).toBe(201);
    expect((await raise({ treeId: '3104', reasonText: '🌳'.repeat(2001) })).status).toBe(400);
  });
});

describe('POST /api/v1/flags refuses', () => {
  it.each([
    {
      name: 'a nine-character reason',
      body: { treeId: '3001', reasonText: 'Too short' },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'nine characters padded with spaces',
      body: { treeId: '3001', reasonText: '   Too short   ' },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a server-owned field',
      body: { treeId: '3001', reasonText: REASON, reasonHash: REASON_HASH },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a tree id past bigint',
      body: { treeId: '9223372036854775808', reasonText: REASON },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a numeric tree id',
      body: { treeId: 3001, reasonText: REASON },
      status: 400,
      code: 'validation_error',
    },
    { name: 'a caller without a wallet', userId: RAKA, status: 403, code: 'wallet_missing' },
    {
      name: 'an unknown tree',
      body: { treeId: '9999', reasonText: REASON },
      status: 404,
      code: 'not_found',
    },
    {
      name: 'Sari, who never contributed (FR-059 acceptance 3)',
      userId: SARI,
      status: 403,
      code: 'not_contributor',
    },
    {
      name: 'Flagged tree 3091 (FR-059 acceptance 2)',
      body: { treeId: '3091', reasonText: REASON },
      status: 409,
      code: 'tree_not_flaggable',
    },
  ])(
    '$name answers $status $code',
    async ({ body = { treeId: '3001', reasonText: REASON }, userId = ALEX, status, code }) => {
      const response = await raise(body, userId);

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );
});

// docs/BE/features/flags.md §2, FR-170.
describe('GET /api/v1/operator/trees/:treeId/flags/:flagId', () => {
  it('answers the §2 example for open flag 3091: the flagger and previous status come from the indexed event', async () => {
    const response = await readFlag('3091', OPEN_FLAG_ID);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      flag: {
        id: OPEN_FLAG_ID,
        treeId: '3091',
        status: 'open',
        reasonText: REASON,
        reasonHash: REASON_HASH,
        flaggerAddress: EVENT_FLAGGER,
        openedAt: '2026-10-20T09:14:27.000Z',
        openedTxHash: OPENED_TX,
        previousStatus: 'alive',
        resolutionNote: null,
        resolvedAt: null,
        resolvedTxHash: null,
      },
      tree: {
        treeId: '3091',
        status: 'flagged',
        campaign: { address: ROOTS, title: 'Roots that stay' },
      },
      resolutionJob: null,
    });
  });

  it('a pending flag has no event: the flagger is the saver, and the previous status and opening are null', async () => {
    const response = await readFlag('3104', PENDING_FLAG_ID);

    expect(response.status).toBe(200);
    expect(response.body.flag).toMatchObject({
      status: 'pending',
      flaggerAddress: ALEX_WALLET,
      previousStatus: null,
      openedAt: null,
      openedTxHash: null,
    });
    expect(response.body.tree.status).toBe('alive');
  });

  it('a decided flag reads as such', async () => {
    const response = await readFlag('3001', UPHELD_FLAG_ID);

    expect(response.status).toBe(200);
    expect(response.body.flag.status).toBe('upheld');
  });
});

describe('GET /api/v1/operator/trees/:treeId/flags/:flagId refuses', () => {
  it.each([
    {
      name: 'a flag of another tree',
      treeId: '3001',
      flagId: OPEN_FLAG_ID,
      status: 404,
      code: 'not_found',
    },
    { name: 'an unknown flag', treeId: '3091', flagId: UNKNOWN_ID, status: 404, code: 'not_found' },
    {
      name: 'a malformed tree id',
      treeId: '0',
      flagId: OPEN_FLAG_ID,
      status: 400,
      code: 'invalid_path',
    },
    {
      name: 'a tree id past bigint',
      treeId: '9223372036854775808',
      flagId: OPEN_FLAG_ID,
      status: 400,
      code: 'invalid_path',
    },
    {
      name: 'a malformed flag id',
      treeId: '3091',
      flagId: '1f6c2a9e',
      status: 400,
      code: 'invalid_path',
    },
    {
      name: 'a donor',
      treeId: '3091',
      flagId: OPEN_FLAG_ID,
      userId: ALEX,
      status: 403,
      code: 'forbidden_role',
    },
    {
      name: 'a planter',
      treeId: '3091',
      flagId: OPEN_FLAG_ID,
      userId: SARI,
      status: 403,
      code: 'forbidden_role',
    },
  ])('$name answers $status $code', async ({ treeId, flagId, userId = RAKA, status, code }) => {
    const response = await readFlag(treeId, flagId, userId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });
});

// docs/BE/features/flags.md §3, FR-171, jobs.md §3.
describe('POST /api/v1/operator/flags/:id/resolve', () => {
  it('queues resolve_flag for open flag 3091 with the frozen payload; the note is stored, the status is not', async () => {
    const response = await resolve(OPEN_FLAG_ID, { uphold: false, note: ` ${NOTE} ` });

    expect(response.status).toBe(202);
    expect(response.body.job).toMatchObject({
      kind: 'resolve_flag',
      status: 'pending',
      txHash: null,
    });
    expect(await jobsKeyed(OPEN_FLAG_ID)).toEqual([
      { id: response.body.job.id, payload: { treeId: '3091', uphold: false, noteHash: NOTE_HASH } },
    ]);
    expect(await flagRow(OPEN_FLAG_ID)).toMatchObject({
      status: 'open',
      resolution_note: NOTE,
      note_hash: NOTE_HASH,
      resolved_by: RAKA,
    });
  });

  it('the same decision again answers 200 with that job, and the first note stands', async () => {
    const [job] = await jobsKeyed(OPEN_FLAG_ID);
    const again = await resolve(OPEN_FLAG_ID, { uphold: false, note: 'A second thought' });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ job: { id: job?.id }, idempotent: true });
    expect((await flagRow(OPEN_FLAG_ID))?.resolution_note).toBe(NOTE);
  });

  it('the other decision while that job is live answers 409 flag_resolution_pending', async () => {
    const response = await resolve(OPEN_FLAG_ID, { uphold: true, note: 'Removed after all' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('flag_resolution_pending');
  });

  it('after the job failed, a new decision re-arms it: 202, the same id, the new payload and note (jobs R5)', async () => {
    const [job] = await jobsKeyed(OPEN_FLAG_ID);

    await sql`update public.relayer_jobs set status = 'failed' where id = ${job?.id}`.execute(
      test.database,
    );

    const response = await resolve(OPEN_FLAG_ID, {
      uphold: true,
      note: 'Stump only on the second visit',
    });

    expect(response.status).toBe(202);
    expect(response.body.job).toMatchObject({ id: job?.id, status: 'pending' });
    expect((await jobsKeyed(OPEN_FLAG_ID))[0]?.payload).toMatchObject({ uphold: true });
    expect((await flagRow(OPEN_FLAG_ID))?.resolution_note).toBe('Stump only on the second visit');
  });
});

describe('POST /api/v1/operator/flags/:id/resolve refuses', () => {
  it.each([
    { name: 'a pending flag', flagId: PENDING_FLAG_ID, status: 'pending' },
    { name: 'an upheld flag', flagId: UPHELD_FLAG_ID, status: 'upheld' },
  ])('$name answers 409 flag_not_open and queues nothing', async ({ flagId, status }) => {
    const response = await resolve(flagId, { uphold: false, note: NOTE });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'flag_not_open', details: { status } });
    expect(await jobsKeyed(flagId)).toEqual([]);
    expect((await flagRow(flagId))?.resolution_note).toBeNull();
  });

  it.each([
    { name: 'an unknown flag', flagId: UNKNOWN_ID, status: 404, code: 'not_found' },
    { name: 'a malformed id', flagId: '1f6c2a9e', status: 400, code: 'invalid_path' },
    { name: 'a donor', userId: ALEX, status: 403, code: 'forbidden_role' },
    {
      name: 'a two-character note',
      body: { uphold: false, note: 'ok' },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a decision that is not a boolean',
      body: { uphold: 'yes', note: NOTE },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'an unknown field',
      body: { uphold: false, note: NOTE, txHash: '0x1' },
      status: 400,
      code: 'validation_error',
    },
  ])(
    '$name answers $status $code',
    async ({
      flagId = UNKNOWN_ID,
      body = { uphold: false, note: NOTE },
      userId = RAKA,
      status,
      code,
    }) => {
      const response = await resolve(flagId, body, userId);

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );
});

// §2 "After a decision is queued": the note and the job, with the raw worker error that operators alone see (NFR-055).
describe('GET /api/v1/operator/trees/:treeId/flags/:flagId with a decision queued', () => {
  it('shows the stored note and the resolve_flag job with its lastError', async () => {
    const [job] = await jobsKeyed(OPEN_FLAG_ID);

    await sql`update public.relayer_jobs set last_error = 'nonce too low' where id = ${job?.id}`.execute(
      test.database,
    );

    const response = await readFlag('3091', OPEN_FLAG_ID);

    expect(response.body.flag).toMatchObject({
      status: 'open',
      resolutionNote: 'Stump only on the second visit',
    });
    expect(response.body.resolutionJob).toEqual({
      id: job?.id,
      kind: 'resolve_flag',
      status: 'pending',
      attempts: 0,
      txHash: null,
      lastError: 'nonce too low',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
});
