import { sql } from 'kysely';
import request from 'supertest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { treeRegistryAbi } from '../../../src/generated/frozen/abis/index.js';
import { CONTAINER_START_MS } from '../../helpers/database.js';
import {
  activeCampaign,
  JAKARTA,
  mined,
  startOnchain,
  submitAndLand,
  waitFor,
  walletOf,
  type Onchain,
} from '../../helpers/onchain.js';
import { planterPhone, type Phone } from '../../helpers/planter-phone.js';
import { aProfile } from '../../fixtures/mirror.js';

// phases.md B6a, ADR-001, ADR-009: a slot claim and a flag resolution, each sent twice through this API, queue one
// job each; the B2 worker relays it to a fresh anvil and the indexer updates the mirror row. In between, Sari plants
// on her slot and Alex, a contributor, flags the tree from his own wallet (flags §5).
const ANVIL_PORT = 8549;
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';
const ALEX = 'did:privy:cm2alex0000000000000000';
const RAKA = 'did:privy:cm2raka0000000000000000';
const REASON = 'Tree condition needs an independent check.';
const NOTE = 'Site visit confirmed the tree is alive and in place';
const NOTE_HASH = '0x37b4ff6197de0d488f0d4bb77772de390a6d69b3c5051dc8989f89bd4b5f5ec6';
const TX_HASH = /^0x[0-9a-f]{64}$/;

let stack: Onchain;
let sari: { phone: Phone; userId: string };
let campaign: Address;
let treeId: string;
let flagId: string;

const post = async (userId: string, path: string, body: object, key?: string) =>
  request(stack.api.app)
    .post(`/api/v1${path}`)
    .set({
      ...(await stack.api.signedIn(userId)),
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    })
    .send(body);

/** Both answers to a double submit: one 202 and one 200 replay, naming the same job (ADR-009). */
const oneJob = (responses: { status: number; body: { job: { id: string } } }[]): string => {
  const [first, second] = responses;

  expect(responses.map(({ status }) => status).sort()).toEqual([200, 202]);
  expect(first?.body.job.id).toBe(second?.body.job.id);

  return first?.body.job.id ?? '';
};

const confirmed = (jobId: string) =>
  waitFor(`job ${jobId} confirmed`, () =>
    stack.row(sql<{ tx_hash: string }>`select tx_hash from public.relayer_jobs
      where id = ${jobId} and status = 'confirmed'`),
  );

const treeStatus = async (): Promise<string | undefined> =>
  (
    await stack.row(sql<{ status: string }>`select status::text from public.trees
      where tree_id = ${treeId}`)
  )?.status;

/** Sari plants on her slot 3 through the evidence API; the tree id once it is mirrored. */
const plantOnSlot3 = async (): Promise<string> => {
  const slots = await request(stack.api.app)
    .get('/api/v1/planter/slots')
    .set(await stack.api.signedIn(SARI));
  const signedCommon = { v: 1 as const, campaign, ...JAKARTA, acc: 6, challenge: null };

  await submitAndLand(
    stack,
    sari,
    { kind: 'PLANTED', campaign, slotId: '3', milestone: 0, contentType: 'video/mp4' },
    {
      ...signedCommon,
      tag: slots.body.items[0].tag.code as string,
      kind: 'PLANTED',
      slotId: '3',
      treeId: null,
      milestone: 0,
      capturedAt: new Date().toISOString(),
    },
  );

  return (
    await waitFor('the planted tree', () =>
      stack.row(sql<{ tree_id: string }>`select tree_id::text from public.trees
        where campaign_address = ${campaign} and slot_id = 3`),
    )
  ).tree_id;
};

beforeAll(async () => {
  stack = await startOnchain(ANVIL_PORT);
  campaign = await activeCampaign(stack, await aProfile(stack.test.database, 'operator', RAKA));
  await aProfile(stack.test.database, 'planter', SARI, SARI_WALLET);
  // Alex signs in with the donor key's wallet, which funded the campaign
  await aProfile(
    stack.test.database,
    'donor',
    ALEX,
    privateKeyToAccount(stack.keys.donor).address.toLowerCase(),
  );
  sari = { phone: await planterPhone(stack.api, SARI), userId: SARI };
}, CONTAINER_START_MS);

afterAll(async () => {
  await stack?.stop();
}, 60_000);

describe('claims and flag resolutions through the API, relayed by the worker, on anvil (ADR-001)', () => {
  it('a claim sent twice with one key queues one job; on anvil Sari holds exactly one slot', async () => {
    const claim = () => post(SARI, `/campaigns/${campaign}/claims`, { count: 1 }, 'b6a-claim');
    const jobId = oneJob(await Promise.all([claim(), claim()]));

    expect((await confirmed(jobId)).tx_hash).toMatch(TX_HASH);

    const slot = await waitFor("Sari's slot mirrored", () =>
      stack.row(sql<{ slot_id: string }>`select slot_id::text from public.slots
        where campaign_address = ${campaign} and planter_address = ${SARI_WALLET}`),
    );
    const held = await stack.row(sql<{ n: number }>`select count(*)::int as n from public.slots
      where campaign_address = ${campaign} and planter_address = ${SARI_WALLET}`);

    expect(slot.slot_id).toBe('3');
    expect(held?.n).toBe(1);
  }, 120_000);

  it('Sari plants on it; Alex saves a reason and flags the tree from his wallet; the indexer opens the flag', async () => {
    treeId = await plantOnSlot3();

    const saved = await post(ALEX, '/flags', { treeId, reasonText: REASON });

    expect(saved.status).toBe(201);
    flagId = saved.body.flag.id as string;

    const flagged = await mined(
      stack,
      walletOf(stack, stack.keys.donor).writeContract({
        address: stack.chain.deployment.treeRegistry,
        abi: treeRegistryAbi,
        functionName: 'flag',
        args: [BigInt(treeId), saved.body.flag.reasonHash as Hex],
      }),
    );
    const opened = await waitFor('the flag opened', () =>
      stack.row(sql<{ opened_tx: string }>`select opened_tx from public.flags
        where id = ${flagId} and status = 'open'`),
    );

    expect(opened.opened_tx).toBe(flagged.transactionHash);
    expect(await treeStatus()).toBe('flagged');
  }, 240_000);

  it('a dismissal sent twice queues one resolve_flag; on anvil the flag is dismissed and the tree is alive', async () => {
    const dismiss = () =>
      post(RAKA, `/operator/flags/${flagId}/resolve`, { uphold: false, note: NOTE });
    const jobId = oneJob(await Promise.all([dismiss(), dismiss()]));
    const job = await confirmed(jobId);
    const resolved = await waitFor('the flag dismissed', () =>
      stack.row(sql<{
        note_hash: string;
        resolved_tx: string;
      }>`select note_hash, resolved_tx from public.flags
        where id = ${flagId} and status = 'dismissed'`),
    );

    expect(resolved).toEqual({ note_hash: NOTE_HASH, resolved_tx: job.tx_hash });
    expect(await treeStatus()).toBe('alive');
  }, 120_000);
});
