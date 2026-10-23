import { sql } from 'kysely';
import request from 'supertest';
import { parseAbi, parseEventLogs, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carbonLedgerAbi } from '../../../src/generated/frozen/abis/index.js';
import { CONTAINER_START_MS } from '../../helpers/database.js';
import {
  activeCampaign,
  checkInForReview,
  claimedTag,
  confirmed,
  mined,
  plantedTree,
  startOnchain,
  waitFor,
  walletOf,
  type Onchain,
  type StackPlanter,
} from '../../helpers/onchain.js';
import { planterPhone } from '../../helpers/planter-phone.js';
import { aProfile } from '../../fixtures/mirror.js';

// phases.md B8: the whole story on a fresh anvil, through this API and the B2 worker. Alex (the donor key) funds the
// campaign; Sari claims, plants and checks in; Raka approves her check-in and the milestone pays; Nadia samples a
// tree and closes the audit; carbon is estimated, issued, priced, and Alex buys and retires some from his own wallet.
// The steps run in order and share the stack.
const ANVIL_PORT = 8552;
const ALEX = 'did:privy:cm2alex0000000000000000';
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';
const RAKA = 'did:privy:cm2raka0000000000000000';
const NADIA = 'did:privy:cm2nadia000000000000000';
const STEP_MS = 300_000;
const PRICE = 1_000_000n;
const BOUGHT = 10n;
const mockUsdcAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

let stack: Onchain;
let sari: StackPlanter;
let campaign: Address;
let treeId = '';

const signedIn = async (userId: string) => stack.api.signedIn(userId);

const post = async (userId: string, path: string, body: object, key?: string) =>
  request(stack.api.app)
    .post(`/api/v1${path}`)
    .set({ ...(await signedIn(userId)), ...(key === undefined ? {} : { 'Idempotency-Key': key }) })
    .send(body);

const get = async (path: string, userId?: string) =>
  request(stack.api.app)
    .get(`/api/v1${path}`)
    .set(userId === undefined ? {} : await signedIn(userId));

/** An operator action through the API, then its job confirmed on anvil. */
const operatorJob = async (path: string, body: object, key: string) => {
  const response = await post(RAKA, path, body, key);

  expect(response.status).toBe(202);

  return confirmed(stack, response.body.job.id as string);
};

/** The operator estimates and issues 0.2 t, then prices the batch; its id once the price is mirrored. */
const pricedBatch = async (): Promise<string> => {
  await operatorJob(`/operator/campaigns/${campaign}/estimate`, {}, 'journey-estimate');
  await operatorJob(
    `/operator/campaigns/${campaign}/issuances`,
    {
      registry: 'SRN-PPI',
      vintage: 2026,
      serialStart: 'IDN-J-1',
      serialEnd: 'IDN-J-200',
      tonnes: '0.2',
    },
    'journey-issue',
  );

  const batch = await waitFor(
    'the issued batch',
    async () => (await get(`/carbon/batches?campaign=${campaign}`)).body.items[0],
  );
  const batchId = batch.batchId as string;

  await operatorJob(
    `/operator/carbon/batches/${batchId}/price`,
    { usdcPerTonne: PRICE.toString() },
    'journey-price',
  );
  await waitFor(
    'the price mirrored',
    async () => (await get(`/carbon/batches/${batchId}`)).body.usdcPerTonne ?? undefined,
  );

  return batchId;
};

/** Alex buys from inventory and retires what he bought, from his own wallet; the retirement id. */
const buyAndRetire = async (batchId: string): Promise<string> => {
  const alex = walletOf(stack, stack.keys.donor);
  const { usdc, carbonLedger } = stack.chain.deployment;
  const cost = (BOUGHT * PRICE + 999n) / 1000n;

  await mined(
    stack,
    alex.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [alex.account.address, cost],
    }),
  );
  await mined(
    stack,
    alex.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [carbonLedger, cost],
    }),
  );
  await mined(
    stack,
    alex.writeContract({
      address: carbonLedger,
      abi: carbonLedgerAbi,
      functionName: 'buy',
      args: [BigInt(batchId), BOUGHT],
    }),
  );

  const retired = await mined(
    stack,
    alex.writeContract({
      address: carbonLedger,
      abi: carbonLedgerAbi,
      functionName: 'retire',
      args: [BigInt(batchId), BOUGHT, 'Alex (journey)', 'Journey offset'],
    }),
  );
  const [event] = parseEventLogs({
    abi: carbonLedgerAbi,
    eventName: 'Retired',
    logs: retired.logs,
  });

  return String(event?.args.retirementId);
};

beforeAll(async () => {
  stack = await startOnchain(ANVIL_PORT);
  await aProfile(
    stack.test.database,
    'donor',
    ALEX,
    privateKeyToAccount(stack.keys.donor).address.toLowerCase(),
  );
  await aProfile(stack.test.database, 'planter', SARI, SARI_WALLET);
  await aProfile(stack.test.database, 'auditor', NADIA);
  sari = { phone: await planterPhone(stack.api, SARI), userId: SARI };
  campaign = await activeCampaign(stack, await aProfile(stack.test.database, 'operator', RAKA));
}, CONTAINER_START_MS);

afterAll(async () => {
  await stack?.stop();
}, 60_000);

describe('journey 1: funding', () => {
  it('a donor contributed from his own wallet: the campaign is Active and fully funded', async () => {
    const page = await get(`/campaigns/${campaign}`, ALEX);

    expect(page.body.campaign).toMatchObject({ status: 'active', fundedAmount: '20000000' });
  });
});

describe('journey 2: planting and a paid milestone', () => {
  it(
    'a planter claims, plants and checks in; an operator approves; the milestone pays',
    async () => {
      const tag = await claimedTag(stack, sari, campaign);

      treeId = await plantedTree(stack, sari, campaign, tag);

      const checkIn = await checkInForReview(stack, sari, { campaign, treeId, tag });
      const approved = await post(RAKA, `/operator/submissions/${checkIn}/review`, {
        approve: true,
        note: 'Seedling clearly visible.',
      });

      expect(approved.status).toBe(202);
      await confirmed(stack, approved.body.job.id as string);
      await waitFor('the month-3 payout', () =>
        stack.row(
          sql`select 1 from public.milestone_payouts where tree_id = ${treeId} and milestone = 1`,
        ),
      );
      expect((await get(`/trees/${treeId}`)).body.summary).toMatchObject({
        milestonesPaid: 2,
        currentMilestone: 2,
      });
    },
    STEP_MS,
  );
});

describe('journey 3: the audit', () => {
  it(
    'an auditor samples the tree, reads its evidence, records a finding and closes; anyone reproduces it',
    async () => {
      const opened = await post(NADIA, '/audit/sessions', { campaign, sampleSize: 1 });
      const id = opened.body.id as string;
      const bundle = await get(`/audit/sessions/${id}/trees/${treeId}`, NADIA);
      const signatures = bundle.body.submissions.map(
        ({ verification }: { verification: { signatureValid: boolean } }) =>
          verification.signatureValid,
      );

      expect(opened.body.samples).toEqual([expect.objectContaining({ treeId })]);
      expect(signatures).toEqual([true, true]);
      await post(NADIA, `/audit/sessions/${id}/findings`, {
        treeId,
        finding: 'ok',
        notes: 'Evidence complete.',
      });

      const closed = await post(NADIA, `/audit/sessions/${id}/close`, {
        summary: 'One tree, verified.',
      });
      const reproduced = await get(`/audit/sessions/${id}/reproduce`);

      expect(closed.body.status).toBe('closed');
      expect(reproduced.body.check).toMatchObject({
        seedMatches: true,
        sampleMatches: true,
        reportMatches: true,
      });
    },
    STEP_MS,
  );
});

describe('journey 4: carbon', () => {
  it(
    'carbon is estimated, issued and priced; the donor buys from inventory and retires for a certificate',
    async () => {
      const retirementId = await buyAndRetire(await pricedBatch());
      const certificate = await waitFor('the certificate', async () => {
        const response = await get(`/carbon/retirements/${retirementId}`);

        return response.status === 200 ? response.body : undefined;
      });
      const holdings = await get('/carbon/holdings', ALEX);

      expect(certificate).toMatchObject({
        amount: BOUGHT.toString(),
        beneficiary: 'Alex (journey)',
      });
      expect(holdings.body.summary.retiredAmount).toBe(BOUGHT.toString());
    },
    STEP_MS,
  );
});
