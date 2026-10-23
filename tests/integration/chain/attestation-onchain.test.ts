import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import request from 'supertest';
import { createTestClient, http, type Address } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_START_MS } from '../../helpers/database.js';
import {
  activeCampaign,
  confirmed,
  JAKARTA,
  oneJob,
  startOnchain,
  submitAndLand,
  TIME_UNIT,
  waitFor,
  type Onchain,
} from '../../helpers/onchain.js';
import { planterPhone, sha256Hex, type Phone } from '../../helpers/planter-phone.js';
import { aProfile } from '../../fixtures/mirror.js';

// phases.md B6c, ADR-001, ADR-009, FR-156: a month-3 check-in the worker scores borderline waits for review; the
// operator approves it twice at once through this API, which signs one attestation and queues one job; the worker
// relays it to a fresh anvil and the tree's month-3 payout lands, so its current milestone moves on.
const ANVIL_PORT = 8551;
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';
const RAKA = 'did:privy:cm2raka0000000000000000';
// the mock AI scores liveness 0.75 for a payload carrying this challenge, which the policy sends to review
// (ai-client.ts MOCK_AI_HOOKS); no challenge is open, so the API's challenge check passes whatever is carried
const REVIEW_CHALLENGE = 'REVIEW-LIVENESS';

let stack: Onchain;
let sari: { phone: Phone; userId: string };
let raka: string;
let campaign: Address;

const signedIn = async (userId: string) => stack.api.signedIn(userId);

/** Sari claims slot 3 through the API; once the indexer mirrors it, her slot list issues its tag. */
const claimedTag = async (): Promise<string> => {
  const claimed = await request(stack.api.app)
    .post(`/api/v1/campaigns/${campaign}/claims`)
    .set(await signedIn(SARI))
    .send({ count: 1 });

  await confirmed(stack, claimed.body.job.id as string);
  await waitFor('the claimed slot', () =>
    stack.row(sql`select 1 from public.slots where campaign_address = ${campaign} and slot_id = 3`),
  );

  const slots = await request(stack.api.app)
    .get('/api/v1/planter/slots')
    .set(await signedIn(SARI));

  return slots.body.items[0].tag.code as string;
};

/** Plants slot 3 and moves chain time into the tree's month-3 window; the tree id. */
const plantedTree = async (tag: string): Promise<string> => {
  await submitAndLand(
    stack,
    sari,
    { kind: 'PLANTED', campaign, slotId: '3', milestone: 0, contentType: 'video/mp4' },
    {
      v: 1,
      kind: 'PLANTED',
      campaign,
      slotId: '3',
      treeId: null,
      milestone: 0,
      ...JAKARTA,
      acc: 6,
      challenge: null,
      tag,
      capturedAt: new Date().toISOString(),
    },
  );

  const tree = await waitFor('the planted tree', () =>
    stack.row(
      sql<{
        tree_id: string;
        planted_at: Date;
      }>`select tree_id::text, planted_at from public.trees where campaign_address = ${campaign} and slot_id = 3`,
    ),
  );
  const anvil = createTestClient({
    chain: foundry,
    mode: 'anvil',
    transport: http(stack.chain.rpcUrl),
  });

  await anvil.setNextBlockTimestamp({
    timestamp: BigInt(Math.floor(tree.planted_at.getTime() / 1000)) + 3n * TIME_UNIT + 5n,
  });
  await anvil.mine({ blocks: 1 });

  return tree.tree_id;
};

/** Submits the month-3 check-in carrying the review hook; its id once the worker sends it to review. */
const checkInForReview = async (treeId: string, tag: string): Promise<string> => {
  const video = randomBytes(256);
  const submissionId = await sari.phone.record(
    { kind: 'ALIVE', campaign, treeId, milestone: 1, contentType: 'video/mp4' },
    video,
  );
  const signed = await sari.phone.sign({
    v: 1,
    kind: 'ALIVE',
    campaign,
    slotId: null,
    treeId,
    milestone: 1,
    ...JAKARTA,
    acc: 6,
    challenge: REVIEW_CHALLENGE,
    tag,
    capturedAt: new Date().toISOString(),
    videoSha256: sha256Hex(video),
    deviceKey: sari.phone.deviceKey,
  });
  const submitted = await request(stack.api.app)
    .post(`/api/v1/evidence/${submissionId}/submit`)
    .set(await signedIn(SARI))
    .send(signed);

  expect(submitted.status).toBe(202);
  await waitFor('the check-in in review', () =>
    stack.row(
      sql`select 1 from public.submissions where id = ${submissionId} and status = 'needs_review'`,
    ),
  );

  return submissionId;
};

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
    const tag = await claimedTag();
    const treeId = await plantedTree(tag);
    const submissionId = await checkInForReview(treeId, tag);
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
