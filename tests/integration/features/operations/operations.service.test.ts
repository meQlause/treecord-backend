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
import { aCampaign, aProfile, theSpecies } from '../../../fixtures/mirror.js';

const address = (index: number): string => `0x${index.toString(16).padStart(40, '0')}`;
// mahogany, nine trees planned, one removed: 8 trees over 36 months, FR-174 acceptance 1
const ROOTS = address(3);
const FUNDING = address(1);
// active, its claim deadline before chain time 2026-10-23T03:12:44Z; no slot taken: three anchors, two open
const PAST_DEADLINE = address(4);
const NO_SPECIES = address(5);
const LOCKED = address(6);
const COMPLETED = address(7);
const RAKA = 'did:privy:cm2raka0000000000000000';
const RINA = 'did:privy:cm2rina0000000000000000';
const ALEX = 'did:privy:cm2alex0000000000000000';
const PLANTER = '0x4B9E2c1D7a3F5e8B0c6D9a2E4f1b3C5d7E9f9D0e';
const ISSUANCE = {
  registry: ' SRN-PPI ',
  vintage: 2026,
  serialStart: 'SRN-2026-00001',
  serialEnd: 'SRN-2026-12500',
  tonnes: '12.5',
};
const TX_HASH = `0x${'1'.repeat(64)}`;

let test: TestDatabase;
let api: TestApi;

const post = async (path: string, body: unknown, key?: string, userId = RAKA) =>
  request(api.app)
    .post(`/api/v1${path}`)
    .set({
      ...(await api.signedIn(userId)),
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    })
    .send(body as object);

const jobsKeyed = async (key: string) =>
  (
    await sql<{
      kind: string;
      payload: object;
      creator: string;
    }>`select j.kind, j.payload, p.privy_user_id as creator from public.relayer_jobs j
      join public.profiles p on p.id = j.created_by_profile_id where j.idempotency_key = ${key}`.execute(
      test.database,
    )
  ).rows;

const estimateColumns = async (campaign: string) =>
  (
    await sql<{
      estimate_method: Record<string, unknown> | null;
      estimated_amount: string | null;
    }>`select estimate_method, estimated_amount::text from public.campaigns
      where address = ${campaign}`.execute(test.database)
  ).rows[0];

// The indexer writes a slot row only once the slot is claimed or assigned (SlotsClaimed, AnchorSlotsAssigned).
const takenSlot = async (
  campaign: string,
  slotId: number,
  kind: 'anchor' | 'open',
  status: string,
) => {
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${campaign}, ${slotId}, ${kind}, ${status}::public.slot_status, ${PLANTER.toLowerCase()})`.execute(
    test.database,
  );
};

/** The six campaigns, and the anchor and open slots the assignments count. */
const theCampaigns = async (): Promise<void> => {
  const active = { status: 'active' as const, species_code: 'SWIETENIA_MACROPHYLLA' };

  await aCampaign(test.database, {
    address: ROOTS,
    ...active,
    tree_target: 9,
    anchor_slots: 4,
    open_slots: 5,
  });
  await aCampaign(test.database, { address: FUNDING, species_code: 'SWIETENIA_MACROPHYLLA' });
  await aCampaign(test.database, {
    address: PAST_DEADLINE,
    ...active,
    claim_deadline: new Date('2026-10-01T00:00:00Z'),
    tree_target: 5,
    anchor_slots: 3,
    open_slots: 2,
  });
  await aCampaign(test.database, { address: NO_SPECIES, status: 'active' });
  await aCampaign(test.database, { address: LOCKED, ...active });
  await aCampaign(test.database, { address: COMPLETED, ...active, status: 'completed' });
  // Roots: anchor 1 assigned, open slot 5 planted, so three anchors and four open slots are free
  await takenSlot(ROOTS, 1, 'anchor', 'claimed');
  await takenSlot(ROOTS, 5, 'open', 'planted');
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await theSpecies(test.database);
  await sql`update public.species set est_kg_co2_per_year_mature = 30, years_to_maturity = 20
    where code = 'SWIETENIA_MACROPHYLLA'`.execute(test.database);

  await theCampaigns();
  await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
      latest_evidence_hash, planted_tx, status)
    values (4001, ${ROOTS}, 5, ${PLANTER.toLowerCase()}, now(), 'qqguw7p', ${TX_HASH}, ${TX_HASH}, 'removed')`.execute(
    test.database,
  );
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx)
    values (101, ${LOCKED}, 12500, 'SRN-PPI', 'A', 'B', 2026, 1, ${TX_HASH})`.execute(
    test.database,
  );
  await aProfile(test.database, 'operator', RAKA);
  await aProfile(test.database, 'operator', RINA);
  await aProfile(test.database, 'donor', ALEX);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

// docs/BE/features/operations.md §2, FR-173, jobs.md §3.
describe('POST /api/v1/operator/campaigns/:address/anchor-assignments', () => {
  it('queues anchor_assign for the wallet, lowercased: 202 { job }', async () => {
    const response = await post(
      `/operator/campaigns/${ROOTS}/anchor-assignments`,
      { planter: PLANTER, count: 3 },
      'anchor-1',
    );

    expect(response.status).toBe(202);
    expect(response.body.job).toMatchObject({
      kind: 'anchor_assign',
      status: 'pending',
      txHash: null,
    });
    expect(await jobsKeyed('anchor-1')).toEqual([
      {
        kind: 'anchor_assign',
        payload: { campaign: ROOTS, planter: PLANTER.toLowerCase(), count: 3 },
        creator: RAKA,
      },
    ]);
  });

  it('counts queued assignments: the three anchors are taken, so one more answers 409 not_enough_slots', async () => {
    const response = await post(`/operator/campaigns/${ROOTS}/anchor-assignments`, {
      planter: PLANTER,
      count: 1,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'not_enough_slots',
      details: { available: 0 },
    });
  });

  it('a retry with the first key still gets its job (jobs R2), another operator with it gets 409', async () => {
    const again = await post(
      `/operator/campaigns/${ROOTS}/anchor-assignments`,
      { planter: PLANTER, count: 3 },
      'anchor-1',
    );
    const stolen = await post(
      `/operator/campaigns/${ROOTS}/anchor-assignments`,
      { planter: PLANTER, count: 3 },
      'anchor-1',
      RINA,
    );

    expect(again.status).toBe(200);
    expect(again.body.idempotent).toBe(true);
    expect(stolen.body.error.code).toBe('idempotency_key_reused');
  });

  it('after the claim deadline (chain time) unclaimed open slots roll over: 3 anchors + 2 open', async () => {
    const five = await post(`/operator/campaigns/${PAST_DEADLINE}/anchor-assignments`, {
      planter: PLANTER,
      count: 5,
    });
    const sixth = await post(`/operator/campaigns/${PAST_DEADLINE}/anchor-assignments`, {
      planter: PLANTER,
      count: 1,
    });

    expect(five.status).toBe(202);
    expect(sixth.body.error).toMatchObject({ code: 'not_enough_slots', details: { available: 0 } });
  });
});

describe('POST /api/v1/operator/campaigns/:address/anchor-assignments refuses', () => {
  it.each([
    {
      name: 'a campaign still funding',
      campaign: FUNDING,
      status: 409,
      code: 'campaign_not_active',
    },
    { name: 'an unknown campaign', campaign: address(99), status: 404, code: 'not_found' },
    { name: 'a malformed address', campaign: '0x12', status: 400, code: 'invalid_path' },
    { name: 'a reserved key', key: 'score:x', status: 400, code: 'invalid_idempotency_key' },
    {
      name: 'a count of 0',
      body: { planter: PLANTER, count: 0 },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a count above 65535',
      body: { planter: PLANTER, count: 65_536 },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a fractional count',
      body: { planter: PLANTER, count: 1.5 },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a bad wallet',
      body: { planter: '0x4b9e', count: 1 },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'an unknown field',
      body: { planter: PLANTER, count: 1, campaign: ROOTS },
      status: 400,
      code: 'validation_error',
    },
    { name: 'a donor', userId: ALEX, status: 403, code: 'forbidden_role' },
  ])(
    '$name answers $status $code',
    async ({
      campaign = ROOTS,
      body = { planter: PLANTER, count: 1 },
      key,
      userId = RAKA,
      status,
      code,
    }) => {
      const response = await post(
        `/operator/campaigns/${campaign}/anchor-assignments`,
        body,
        key,
        userId,
      );

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );
});

// §3, FR-174, ADR-015.
describe('POST /api/v1/operator/campaigns/:address/estimate', () => {
  it('queues estimate for 8 trees (9 planned, 1 removed): 54 units; writes the method, not estimated_amount', async () => {
    const response = await post(`/operator/campaigns/${ROOTS}/estimate`, {}, 'estimate-1');
    const columns = await estimateColumns(ROOTS);

    expect(response.status).toBe(202);
    expect((await jobsKeyed('estimate-1'))[0]?.payload).toEqual({
      campaign: ROOTS,
      estimatedAmount: '54',
    });
    expect(columns?.estimated_amount).toBeNull();
    expect(columns?.estimate_method).toEqual({
      model: 'linear-maturity-v1',
      label: 'pre-certification',
      formula: expect.any(String),
      kgCo2PerYearMature: '30.00',
      yearsToMaturity: 20,
      treeCount: 8,
      commitmentMonths: 36,
      amount: '54',
      kgPerTree: '6.75',
      averageMaturityBps: 750,
      species: { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
      computedAt: '2026-10-23T03:12:44.000Z',
      jobId: response.body.job.id,
    });
  });

  it.each([
    {
      name: 'a campaign still funding',
      campaign: FUNDING,
      code: 'campaign_not_active',
      details: { status: 'funding' },
    },
    { name: 'a campaign with a mirrored batch', campaign: LOCKED, code: 'estimate_locked' },
    { name: 'a campaign without a species', campaign: NO_SPECIES, code: 'species_unknown' },
  ])(
    '$name answers 409 $code, queues nothing and writes no method',
    async ({ campaign, code, details }) => {
      const key = `estimate-${code}`;
      const response = await post(`/operator/campaigns/${campaign}/estimate`, {}, key);

      expect(response.status).toBe(409);
      expect(response.body.error).toMatchObject({
        code,
        ...(details === undefined ? {} : { details }),
      });
      expect(await jobsKeyed(key)).toEqual([]);
      expect((await estimateColumns(campaign))?.estimate_method).toBeNull();
    },
  );

  it('takes no input: a typed amount answers 400 validation_error', async () => {
    const response = await post(`/operator/campaigns/${ROOTS}/estimate`, {
      estimatedAmount: '9000',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });
});

// §4, FR-175, FR-215, REG-001.
describe('POST /api/v1/operator/campaigns/:address/issuances', () => {
  it('queues issue with the tonnes converted to units and the registry trimmed', async () => {
    const response = await post(`/operator/campaigns/${ROOTS}/issuances`, ISSUANCE, 'issue-1');

    expect(response.status).toBe(202);
    expect((await jobsKeyed('issue-1'))[0]?.payload).toEqual({
      campaign: ROOTS,
      registry: 'SRN-PPI',
      vintage: 2026,
      serialStart: 'SRN-2026-00001',
      serialEnd: 'SRN-2026-12500',
      amount: '12500',
    });
  });

  it('the same key with another body answers 200 with the first job: the first intent wins', async () => {
    const again = await post(
      `/operator/campaigns/${ROOTS}/issuances`,
      { ...ISSUANCE, tonnes: '99' },
      'issue-1',
    );

    expect(again.status).toBe(200);
    expect((await jobsKeyed('issue-1'))[0]?.payload).toMatchObject({ amount: '12500' });
  });

  it('a Completed campaign is issuable; an amount past 2^53 stays a string', async () => {
    const response = await post(
      `/operator/campaigns/${COMPLETED}/issuances`,
      { ...ISSUANCE, tonnes: '999999999999999999.999' },
      'issue-big',
    );

    expect(response.status).toBe(202);
    expect((await jobsKeyed('issue-big'))[0]?.payload).toMatchObject({
      amount: '999999999999999999999',
    });
  });
});

describe('POST /api/v1/operator/campaigns/:address/issuances refuses', () => {
  it.each([
    { name: 'no Idempotency-Key', key: null, status: 400, code: 'invalid_idempotency_key' },
    {
      name: 'a campaign still funding',
      campaign: FUNDING,
      status: 409,
      code: 'campaign_not_issuable',
    },
    {
      name: 'four decimals of tonnes (FR-175 acceptance 2)',
      change: { tonnes: '1.2345' },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'tonnes as a JSON number',
      change: { tonnes: 12.5 },
      status: 400,
      code: 'validation_error',
    },
    { name: 'zero tonnes', change: { tonnes: '0.000' }, status: 400, code: 'validation_error' },
    {
      name: 'a one-letter registry',
      change: { registry: ' S ' },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'a vintage before 2000',
      change: { vintage: 1999 },
      status: 400,
      code: 'validation_error',
    },
    { name: 'an unknown campaign', campaign: address(99), status: 404, code: 'not_found' },
  ])(
    '$name answers $status $code and queues nothing',
    async ({ campaign = ROOTS, change = {}, key = 'issue-refused', status, code }) => {
      const response = await post(
        `/operator/campaigns/${campaign}/issuances`,
        { ...ISSUANCE, ...change },
        key ?? undefined,
      );

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(await jobsKeyed('issue-refused')).toEqual([]);
    },
  );
});

// §5, FR-176, FR-216.
describe('POST /api/v1/operator/carbon/batches/:batchId/price', () => {
  it.each([
    ['15 USDC a tonne', '15000000'],
    ['0, which pauses sales', '0'],
    ['the uint256 ceiling', (2n ** 256n - 1n).toString()],
  ])('queues set_price at %s', async (_case, usdcPerTonne) => {
    const key = `price-${usdcPerTonne}`;
    const response = await post('/operator/carbon/batches/101/price', { usdcPerTonne }, key);

    expect(response.status).toBe(202);
    expect((await jobsKeyed(key))[0]?.payload).toEqual({ batchId: '101', usdcPerTonne });
  });

  it.each([
    { name: 'a batch not mirrored yet', batchId: '999', status: 404, code: 'not_found' },
    { name: 'batch 0', batchId: '0', status: 400, code: 'invalid_path' },
    { name: 'a JSON number', body: { usdcPerTonne: 15 }, status: 400, code: 'validation_error' },
    {
      name: 'a decimal point',
      body: { usdcPerTonne: '18.5' },
      status: 400,
      code: 'validation_error',
    },
    {
      name: 'past uint256',
      body: { usdcPerTonne: (2n ** 256n).toString() },
      status: 400,
      code: 'validation_error',
    },
    { name: 'a donor', userId: ALEX, status: 403, code: 'forbidden_role' },
  ])(
    '$name answers $status $code',
    async ({ batchId = '101', body = { usdcPerTonne: '1' }, userId = RAKA, status, code }) => {
      const response = await post(
        `/operator/carbon/batches/${batchId}/price`,
        body,
        undefined,
        userId,
      );

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );
});
