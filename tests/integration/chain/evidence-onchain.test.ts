import { sql } from 'kysely';
import request from 'supertest';
import { createTestClient, http, type Address } from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTAINER_START_MS } from '../../helpers/database.js';
import {
  activeCampaign,
  JAKARTA,
  startOnchain,
  submitAndLand,
  TIME_UNIT,
  waitFor,
  type Onchain,
} from '../../helpers/onchain.js';
import { planterPhone, type Phone } from '../../helpers/planter-phone.js';
import { aProfile } from '../../fixtures/mirror.js';

// phases.md B5b, ADR-001: a planting and a check-in submitted through this API are scored by the B2 worker, attested
// and land on a fresh anvil, the worker reading the jobs the API wrote.
const ANVIL_PORT = 8548;
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';

let stack: Onchain;
let sari: { phone: Phone; userId: string };
let raka: string;

/** The operator relays a slot claim for Sari; once the indexer mirrors slot 3, her slot list issues its tag. */
const claimedSlotTag = async (campaign: Address): Promise<string> => {
  await sql`insert into public.relayer_jobs (kind, payload)
    values ('claim', ${JSON.stringify({ campaign, planter: SARI_WALLET, count: 1 })}::jsonb)`.execute(
    stack.test.database,
  );
  await waitFor('the claimed slot', () =>
    stack.row(sql`select 1 from public.slots where campaign_address = ${campaign} and slot_id = 3
      and planter_address = ${SARI_WALLET}`),
  );

  const slots = await request(stack.api.app)
    .get('/api/v1/planter/slots')
    .set(await stack.api.signedIn(SARI));

  return slots.body.items[0].tag.code as string;
};

beforeAll(async () => {
  stack = await startOnchain(ANVIL_PORT);
  raka = await aProfile(stack.test.database, 'operator', 'did:privy:cm2raka0000000000000000');
  await aProfile(stack.test.database, 'planter', SARI, SARI_WALLET);
  sari = { phone: await planterPhone(stack.api, SARI), userId: SARI };
}, CONTAINER_START_MS);

afterAll(async () => {
  await stack?.stop();
}, 60_000);

describe('evidence through the API, scored by the worker, on anvil (ADR-001)', () => {
  it('a planting and its month-3 check-in each reach onchain', async () => {
    const campaign = await activeCampaign(stack, raka);
    const tag = await claimedSlotTag(campaign);

    const signedCommon = { v: 1 as const, campaign, ...JAKARTA, acc: 6, challenge: null, tag };
    const planting = await submitAndLand(
      stack,
      sari,
      { kind: 'PLANTED', campaign, slotId: '3', milestone: 0, contentType: 'video/mp4' },
      {
        ...signedCommon,
        kind: 'PLANTED',
        slotId: '3',
        treeId: null,
        milestone: 0,
        capturedAt: new Date().toISOString(),
      },
    );
    const tree = await waitFor('the planted tree', () =>
      stack.row(sql<{
        tree_id: string;
        planted_at: Date;
      }>`select tree_id::text, planted_at from public.trees
        where campaign_address = ${campaign} and slot_id = 3`),
    );

    expect(planting.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

    // chain time into the month-3 window (one time unit of 60 s per month here); the server clock stays real
    const opensAt = BigInt(Math.floor(tree.planted_at.getTime() / 1000)) + 3n * TIME_UNIT;
    const anvil = createTestClient({
      chain: foundry,
      mode: 'anvil',
      transport: http(stack.chain.rpcUrl),
    });

    await anvil.setNextBlockTimestamp({ timestamp: opensAt + 5n });
    await anvil.mine({ blocks: 1 });

    const checkIn = await submitAndLand(
      stack,
      sari,
      { kind: 'ALIVE', campaign, treeId: tree.tree_id, milestone: 1, contentType: 'video/mp4' },
      {
        ...signedCommon,
        kind: 'ALIVE',
        slotId: null,
        treeId: tree.tree_id,
        milestone: 1,
        capturedAt: new Date().toISOString(),
      },
    );
    const payout = await waitFor('the month-3 payout', () =>
      stack.row(sql<{ amount: string }>`select amount::text from public.milestone_payouts
        where tree_id = ${tree.tree_id} and milestone = 1`),
    );

    expect(checkIn.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(payout.amount)).toBeGreaterThan(0n);
  }, 240_000);
});
