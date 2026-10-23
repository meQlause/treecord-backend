import { sql } from 'kysely';
import request from 'supertest';
import { type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_START_MS } from '../../helpers/database.js';
import {
  activeCampaign,
  checkInForReview,
  claimedTag,
  confirmed,
  oneJob,
  plantedTree,
  startOnchain,
  waitFor,
  type Onchain,
} from '../../helpers/onchain.js';
import { planterPhone, type Phone } from '../../helpers/planter-phone.js';
import { aProfile } from '../../fixtures/mirror.js';

// phases.md B6c, ADR-001, ADR-009, FR-156: a month-3 check-in the worker scores borderline waits for review; the
// operator approves it twice at once through this API, which signs one attestation and queues one job; the worker
// relays it to a fresh anvil and the tree's month-3 payout lands, so its current milestone moves on.
const ANVIL_PORT = 8551;
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';
const RAKA = 'did:privy:cm2raka0000000000000000';

let stack: Onchain;
let sari: { phone: Phone; userId: string };
let raka: string;
let campaign: Address;

const signedIn = async (userId: string) => stack.api.signedIn(userId);

beforeAll(async () => {
  stack = await startOnchain(ANVIL_PORT);
  raka = await aProfile(stack.test.database, 'operator', RAKA);
  campaign = await activeCampaign(stack, raka);
  await aProfile(stack.test.database, 'planter', SARI, SARI_WALLET);
  sari = { phone: await planterPhone(stack.api, SARI), userId: SARI };
}, CONTAINER_START_MS);

afterAll(async () => {
  await stack?.stop();
}, 60_000);

describe('an operator-approved check-in on anvil (ADR-001, FR-156)', () => {
  it('approved twice at once: one attestation job, the check-in onchain, the tree on to its next milestone', async () => {
    const tag = await claimedTag(stack, sari, campaign);
    const treeId = await plantedTree(stack, sari, campaign, tag);
    const submissionId = await checkInForReview(stack, sari, { campaign, treeId, tag });
    const approve = async () =>
      request(stack.api.app)
        .post(`/api/v1/operator/submissions/${submissionId}/review`)
        .set(await signedIn(RAKA))
        .send({ approve: true, note: 'Seedling clearly visible.' });
    const jobId = oneJob(await Promise.all([approve(), approve()]));

    await confirmed(stack, jobId);
    await waitFor('the month-3 payout', () =>
      stack.row(
        sql`select 1 from public.milestone_payouts where tree_id = ${treeId} and milestone = 1`,
      ),
    );

    const landed = await stack.row(sql<{
      status: string;
    }>`select status::text from public.submissions
      where id = ${submissionId}`);
    const page = await request(stack.api.app).get(`/api/v1/trees/${treeId}`);

    expect(landed?.status).toBe('onchain');
    expect(page.body.summary).toMatchObject({
      milestonesPaid: 2,
      currentMilestone: 2,
      currentMonth: 6,
    });
  }, 300_000);
});
