import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { enqueue } from '../../src/features/jobs/jobs.service.js';
import { testApi, type TestApi } from '../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../helpers/database.js';
import { fakePrivy } from '../helpers/fake-privy.js';
import { aCampaign, aProfile, theSpecies } from '../fixtures/mirror.js';

// REG-001 (docs/BE/testing.md §4): amounts and ids lost digits when parsed as JS numbers. 2^53 + 1 is the first
// integer a JSON number cannot hold.
const BEYOND_DOUBLE = '9007199254740993';
// a uint256 amount far past 2^53, with a remainder in every bucket of the budget split
const HUGE = '90071992547409930000';
const CAMPAIGN = `0x${'b'.repeat(40)}`;
const WALLET = `0x${'a'.repeat(40)}`;
const CHAIN_TX = `0x${'1'.repeat(64)}`;
const EVIDENCE = `0x${'2'.repeat(64)}`;
const RAKA = 'did:privy:cm2raka0000000000000000';

let test: TestDatabase;
let api: TestApi;

// A campaign whose every amount is past 2^53, with tree ${BEYOND_DOUBLE}, a payout, an evidence event and a batch.
const seedHugeCampaign = async (database: TestDatabase['database']): Promise<void> => {
  await theSpecies(database);
  await aCampaign(database, {
    address: CAMPAIGN,
    funding_target: HUGE,
    funded_amount: BEYOND_DOUBLE,
    incentive_pool: HUGE,
    per_tree_incentive: BEYOND_DOUBLE,
    estimated_amount: BEYOND_DOUBLE,
  });
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${CAMPAIGN}, 1, 'open', 'planted', ${WALLET})`.execute(database);
  await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
      latest_evidence_hash, planted_tx)
    values (${BEYOND_DOUBLE}, ${CAMPAIGN}, 1, ${WALLET}, '2026-04-18T05:00:00Z', 'qqtttzp', ${EVIDENCE}, ${CHAIN_TX})`.execute(
    database,
  );
  await sql`insert into public.milestone_payouts (tree_id, campaign_address, milestone, amount, planter_address,
      block_number, block_time, log_index, tx_hash)
    values (${BEYOND_DOUBLE}, ${CAMPAIGN}, 0, ${BEYOND_DOUBLE}, ${WALLET}, ${BEYOND_DOUBLE}, now(), 0, ${CHAIN_TX})`.execute(
    database,
  );
  await sql`insert into public.tree_events (tree_id, kind, block_number, block_time, log_index, tx_hash, evidence_hash)
    values (${BEYOND_DOUBLE}, 'planted', ${BEYOND_DOUBLE}, now(), 0, ${CHAIN_TX}, ${EVIDENCE})`.execute(
    database,
  );
  await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
      serial_end, vintage, issued_block, issued_tx)
    values (${BEYOND_DOUBLE}, ${CAMPAIGN}, ${HUGE}, 'SRN PPI', 'S-1', 'S-2', 2026, 1, ${CHAIN_TX})`.execute(
    database,
  );
};

// Every number in a body, wherever it sits.
const numbersIn = (value: unknown): number[] => {
  if (typeof value === 'number') {
    return [value];
  }

  return typeof value === 'object' && value !== null ? Object.values(value).flatMap(numbersIn) : [];
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  api = testApi(test.database, await fakePrivy());
  await seedHugeCampaign(test.database);
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

it(`${BEYOND_DOUBLE} round-trips through a job payload as the exact decimal string`, async () => {
  const raka = await aProfile(test.database, 'operator', RAKA);
  const { job } = await test.database.transaction().execute((trx) =>
    enqueue(trx, {
      kind: 'set_price',
      payload: { batchId: BEYOND_DOUBLE, usdcPerTonne: BEYOND_DOUBLE },
      createdBy: raka,
      idempotencyKey: null,
    }),
  );
  const stored = await sql<{ batch_id: string; price: string }>`
    select payload->>'batchId' as batch_id, payload->>'usdcPerTonne' as price
    from public.relayer_jobs where id = ${job.id}`.execute(test.database);

  expect(stored.rows).toEqual([{ batch_id: BEYOND_DOUBLE, price: BEYOND_DOUBLE }]);

  const response = await request(api.app)
    .get(`/api/v1/jobs/${job.id}`)
    .set(await api.signedIn(RAKA));

  expect(response.body.job.context.batchId).toBe(BEYOND_DOUBLE);
  expect(response.text).toContain(`"batchId":"${BEYOND_DOUBLE}"`);
});

it.each([
  ['the catalog', '/api/v1/campaigns'],
  ['the campaign page', `/api/v1/campaigns/${CAMPAIGN}`],
  ['the tree page', `/api/v1/trees/${BEYOND_DOUBLE}`],
  ['the impact report', `/api/v1/reports/campaign/${CAMPAIGN}`],
  ['the evidence record', `/api/v1/reports/campaign/${CAMPAIGN}/evidence`],
])(
  '%s carries every amount and id as an exact decimal string, never a JSON number',
  async (_page, path) => {
    const response = await request(api.app).get(path);

    expect(response.status).toBe(200);
    expect(response.text).toContain(`"${BEYOND_DOUBLE}"`);
    // 2^53 + 1 parses to 2^53: any unsafe integer in the body is a uint256 or bigint that went through a number
    expect(
      numbersIn(response.body).filter(
        (value) => !Number.isSafeInteger(value) && Number.isInteger(value),
      ),
    ).toEqual([]);
  },
);

it('the budget of a campaign past 2^53 sums to its target to the unit', async () => {
  const { budget } = (await request(api.app).get(`/api/v1/campaigns/${CAMPAIGN}`)).body.campaign;

  expect(
    budget.reduce((sum: bigint, line: { amount: string }) => sum + BigInt(line.amount), 0n),
  ).toBe(BigInt(HUGE));
});
