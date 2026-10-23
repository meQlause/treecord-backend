import { sql } from 'kysely';
import request from 'supertest';
import type { Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_START_MS } from '../../helpers/database.js';
import {
  activeCampaign,
  confirmed,
  oneJob,
  startOnchain,
  waitFor,
  type Onchain,
} from '../../helpers/onchain.js';
import { aProfile } from '../../fixtures/mirror.js';

// phases.md B6b, ADR-001, ADR-009: each operator action sent twice through this API queues one job; the B2 worker
// relays it to a fresh anvil and the indexer updates the mirror row the action is about.
const ANVIL_PORT = 8550;
const RAKA = 'did:privy:cm2raka0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';
const JOB_MS = 120_000;

let stack: Onchain;
let campaign: Address;
let batchId: string;

/** The same request twice at once, with one key, as the operator; the one job both answers name. */
const twice = async (path: string, body: object, key: string): Promise<string> => {
  const send = async () =>
    request(stack.api.app)
      .post(`/api/v1${path}`)
      .set({ ...(await stack.api.signedIn(RAKA)), 'Idempotency-Key': key })
      .send(body);

  return oneJob(await Promise.all([send(), send()]));
};

const jobsKeyed = async (key: string) =>
  (
    await stack.row(sql<{ n: number }>`select count(*)::int as n from public.relayer_jobs
      where idempotency_key = ${key}`)
  )?.n;

beforeAll(async () => {
  stack = await startOnchain(ANVIL_PORT);
  // ten mahogany trees, two of them anchor slots (tests/helpers/onchain.ts)
  campaign = await activeCampaign(stack, await aProfile(stack.test.database, 'operator', RAKA));
}, CONTAINER_START_MS);

afterAll(async () => {
  await stack?.stop();
}, 60_000);

describe('operator campaign actions through the API, relayed by the worker, on anvil (ADR-001)', () => {
  it(
    'anchor_assign: both anchor slots land with Sari as their planter',
    async () => {
      const jobId = await twice(
        `/operator/campaigns/${campaign}/anchor-assignments`,
        { planter: SARI_WALLET, count: 2 },
        'ops-anchor',
      );

      await confirmed(stack, jobId);

      const assigned = await waitFor('the anchor slots mirrored', () =>
        stack.row(sql<{ n: number }>`select count(*)::int as n from public.slots
        where campaign_address = ${campaign} and kind = 'anchor' and planter_address = ${SARI_WALLET}
        having count(*) = 2`),
      );

      expect(assigned.n).toBe(2);
      expect(await jobsKeyed('ops-anchor')).toBe(1);
    },
    JOB_MS,
  );

  it(
    'estimate: the indexer, not the API, writes estimated_amount, and it matches the method',
    async () => {
      const jobId = await twice(`/operator/campaigns/${campaign}/estimate`, {}, 'ops-estimate');

      await confirmed(stack, jobId);

      const estimated = await waitFor('EstimateSet mirrored', () =>
        stack.row(sql<{
          estimated_amount: string;
          method_amount: string;
        }>`select estimated_amount::text, estimate_method->>'amount' as method_amount
        from public.campaigns where address = ${campaign} and estimated_amount is not null`),
      );

      // 10 trees × 22 kg/yr, 10 years to maturity, 36 months: floor(10 × 2200 × 1296 / 288000) = 99
      expect(estimated).toEqual({ estimated_amount: '99', method_amount: '99' });
      expect(await jobsKeyed('ops-estimate')).toBe(1);
    },
    JOB_MS,
  );
});

// after the estimate, which an issuance locks
describe('operator carbon actions through the API, relayed by the worker, on anvil (ADR-001)', () => {
  it(
    'issue: one batch of 50 units is mirrored for the campaign',
    async () => {
      const jobId = await twice(
        `/operator/campaigns/${campaign}/issuances`,
        {
          registry: 'SRN-PPI',
          vintage: 2026,
          serialStart: 'SRN-2026-00001',
          serialEnd: 'SRN-2026-00050',
          tonnes: '0.05',
        },
        'ops-issue',
      );

      await confirmed(stack, jobId);

      const batch = await waitFor('BatchIssued mirrored', () =>
        stack.row(sql<{
          batch_id: string;
          amount: string;
        }>`select batch_id::text, amount::text from public.carbon_batches
        where campaign_address = ${campaign}`),
      );

      batchId = batch.batch_id;
      expect(batch.amount).toBe('50');
      expect(await jobsKeyed('ops-issue')).toBe(1);
    },
    JOB_MS,
  );

  it(
    'set_price: the batch is priced at 15 USDC a tonne',
    async () => {
      const jobId = await twice(
        `/operator/carbon/batches/${batchId}/price`,
        { usdcPerTonne: '15000000' },
        'ops-price',
      );

      await confirmed(stack, jobId);

      const priced = await waitFor('PriceSet mirrored', () =>
        stack.row(sql<{ price: string }>`select price_usdc_per_tonne::text as price
        from public.carbon_batches where batch_id = ${batchId} and price_usdc_per_tonne is not null`),
      );

      expect(priced.price).toBe('15000000');
      expect(await jobsKeyed('ops-price')).toBe(1);
    },
    JOB_MS,
  );
});
