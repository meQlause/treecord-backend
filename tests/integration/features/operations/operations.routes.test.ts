import { sql } from 'kysely';
import request from 'supertest';
import { HttpRequestError } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApi, type TestApi } from '../../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../../helpers/database.js';
import { fakePrivy, type FakePrivy } from '../../../helpers/fake-privy.js';
import { aCampaign, aJob, aProfile, theSpecies } from '../../../fixtures/mirror.js';

const address = (index: number): string => `0x${index.toString(16).padStart(40, '0')}`;
// Active; 9 planned trees, one Removed (8 trees: 54 units, FR-174 acceptance 1); one anchor assigned; two queued
const ROOTS = address(3);
// Active and past its claim deadline (chain time 2026-10-23T03:12:44Z): open slots roll over
const PAST_DEADLINE = address(4);
// no species: the preview cannot be computed
const NO_SPECIES = address(5);
// a mirrored batch locks the estimate; the confirmed estimate matches the method written for it
const LOCKED = address(6);
// the same, but a newer method was queued and has not been confirmed yet
const STALE = address(7);
// 21 queued jobs: only the newest 20 are shown
const BUSY = address(8);
const RAKA = 'did:privy:cm2raka0000000000000000';
const ALEX = 'did:privy:cm2alex0000000000000000';
const PLANTER = '0x4b9e2c1d7a3f5e8b0c6d9a2e4f1b3c5d7e9f9d0e';
const TX_HASH = `0x${'1'.repeat(64)}`;
const ISO = expect.any(String);

const METHOD = {
  model: 'linear-maturity-v1',
  label: 'pre-certification',
  amount: '99',
  kgPerTree: '6.75',
  jobId: '6e4f2b9d-8a1c-4d3e-b5f7-2c9a0e1d3b84',
};

let test: TestDatabase;
let privy: FakePrivy;
let api: TestApi;
const jobIds: Record<string, string> = {};

const read = async (campaign: string, userId = RAKA, app: TestApi = api) =>
  request(app.app)
    .get(`/api/v1/operator/campaigns/${campaign}`)
    .set(await app.signedIn(userId));

type QueuedJob = {
  kind: 'anchor_assign' | 'estimate' | 'issue' | 'set_price';
  payload: Record<string, string | number>;
  status: 'pending' | 'processing' | 'sent' | 'confirmed' | 'failed';
  createdAt: string;
};

const queue = async (name: string, { kind, payload, status, createdAt }: QueuedJob) => {
  jobIds[name] = await aJob(test.database, null, {
    kind,
    payload,
    status,
    created_at: new Date(createdAt),
    attempts: status === 'sent' ? 1 : 0,
    tx_hash: status === 'sent' ? TX_HASH : null,
  });
};

const slot = async (campaign: string, slotId: number, kind: 'anchor' | 'open', status: string) => {
  await sql`insert into public.slots (campaign_address, slot_id, kind, status, planter_address)
    values (${campaign}, ${slotId}, ${kind}, ${status}::public.slot_status, ${PLANTER})`.execute(
    test.database,
  );
};

const campaigns = async () => {
  const active = { status: 'active' as const, species_code: 'SWIETENIA_MACROPHYLLA' };

  await aCampaign(test.database, {
    address: ROOTS,
    ...active,
    title: 'Roots that stay',
    tree_target: 9,
    anchor_slots: 4,
    open_slots: 5,
  });
  await aCampaign(test.database, {
    address: PAST_DEADLINE,
    ...active,
    tree_target: 5,
    anchor_slots: 3,
    open_slots: 2,
    claim_deadline: new Date('2026-10-01T00:00:00Z'),
  });
  await aCampaign(test.database, {
    address: NO_SPECIES,
    status: 'active',
    tree_target: 5,
    anchor_slots: 1,
    open_slots: 4,
  });
  await aCampaign(test.database, {
    address: LOCKED,
    ...active,
    estimated_amount: '99',
    estimate_method: JSON.stringify(METHOD),
  });
  await aCampaign(test.database, {
    address: STALE,
    ...active,
    estimated_amount: '50',
    estimate_method: JSON.stringify(METHOD),
  });
  await aCampaign(test.database, { address: BUSY, ...active });
};

const records = async () => {
  await slot(ROOTS, 1, 'anchor', 'claimed');
  await slot(ROOTS, 5, 'open', 'planted');
  await sql`insert into public.trees (tree_id, campaign_address, slot_id, planter_address, planted_at, geohash,
      latest_evidence_hash, planted_tx, status)
    values (4001, ${ROOTS}, 5, ${PLANTER}, now(), 'qqguw7p', ${TX_HASH}, ${TX_HASH}, 'removed')`.execute(
    test.database,
  );

  for (const campaign of [LOCKED, STALE]) {
    await sql`insert into public.carbon_batches (batch_id, campaign_address, amount, registry, serial_start,
        serial_end, vintage, issued_block, issued_tx)
      values (${campaign === LOCKED ? 101 : 102}, ${campaign}, 12500, 'SRN-PPI', 'A', 'B', 2026, 1, ${TX_HASH})`.execute(
      test.database,
    );
  }
};

const stamp = (time: string): string => `2026-10-23T${time}Z`;

const jobs = async () => {
  const anchors = (count: number) => ({ campaign: ROOTS, planter: PLANTER, count });
  const estimate = { campaign: ROOTS, estimatedAmount: '54' };

  await queue('confirmed', {
    kind: 'anchor_assign',
    payload: anchors(5),
    status: 'confirmed',
    createdAt: stamp('07:00:00'),
  });
  await queue('pending', {
    kind: 'anchor_assign',
    payload: anchors(1),
    status: 'pending',
    createdAt: stamp('08:00:00'),
  });
  await queue('sent', {
    kind: 'anchor_assign',
    payload: anchors(1),
    status: 'sent',
    createdAt: stamp('09:00:00'),
  });
  await queue('estimate', {
    kind: 'estimate',
    payload: estimate,
    status: 'processing',
    createdAt: stamp('10:00:00'),
  });
  await queue('failed', {
    kind: 'estimate',
    payload: estimate,
    status: 'failed',
    createdAt: stamp('11:00:00'),
  });
  await queue('price', {
    kind: 'set_price',
    payload: { batchId: '101', usdcPerTonne: '15000000' },
    status: 'pending',
    createdAt: stamp('08:30:00'),
  });
  await queue('otherPrice', {
    kind: 'set_price',
    payload: { batchId: '102', usdcPerTonne: '1' },
    status: 'pending',
    createdAt: stamp('08:31:00'),
  });

  for (let minute = 0; minute < 21; minute += 1) {
    await queue(`busy${minute}`, {
      kind: 'issue',
      payload: { campaign: BUSY, registry: 'SRN' },
      status: 'pending',
      createdAt: stamp(`12:${String(minute).padStart(2, '0')}:00`),
    });
  }
};

beforeAll(async () => {
  test = await startMigratedDatabase();
  privy = await fakePrivy();
  api = testApi(test.database, privy);
  await theSpecies(test.database);
  await sql`update public.species set est_kg_co2_per_year_mature = 30, years_to_maturity = 20
    where code = 'SWIETENIA_MACROPHYLLA'`.execute(test.database);
  await campaigns();
  await records();
  await aProfile(test.database, 'operator', RAKA);
  await aProfile(test.database, 'donor', ALEX);
  await jobs();
}, CONTAINER_START_MS);

afterAll(async () => {
  await test.stop();
});

const summary = (
  name: string,
  {
    kind,
    status,
    attempts = 0,
    txHash = null,
  }: { kind: string; status: string; attempts?: number; txHash?: string | null },
) => ({ id: jobIds[name], kind, status, attempts, txHash, createdAt: ISO, updatedAt: ISO });

// docs/BE/features/operations.md §1, FR-172–FR-177, at chain time 2026-10-23T03:12:44Z.
describe('GET /api/v1/operator/campaigns/:address', () => {
  it('answers the §1 shape for Roots that stay: anchors, a 54-unit preview, no estimate yet, queued work', async () => {
    const response = await read(ROOTS);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      campaign: {
        address: ROOTS,
        title: 'Roots that stay',
        status: 'active',
        claimDeadline: '2026-12-10T00:00:00.000Z',
      },
      // 3 anchors unassigned, the claim deadline is ahead (null), 2 queued: 3 + 0 - 2
      anchor: {
        unassignedAnchorSlots: 3,
        rolledOverOpenSlots: null,
        queuedSlots: 2,
        availableSlots: 1,
      },
      estimate: {
        method: 'linear-maturity-v1',
        species: { code: 'SWIETENIA_MACROPHYLLA', name: 'Mahogany' },
        treeTarget: 9,
        removedTrees: 1,
        treeCount: 8,
        commitmentMonths: 36,
        kgCo2PerYearMature: '30.00',
        yearsToMaturity: 20,
        kgPerTree: '6.75',
        averageMaturityBps: 750,
        previewAmount: '54',
        label: 'pre-certification',
        current: null,
        locked: false,
      },
      // newest first; the confirmed and failed jobs and another campaign's jobs stay out
      queuedJobs: [
        summary('estimate', { kind: 'estimate', status: 'processing' }),
        summary('sent', { kind: 'anchor_assign', status: 'sent', attempts: 1, txHash: TX_HASH }),
        summary('pending', { kind: 'anchor_assign', status: 'pending' }),
      ],
    });
  });

  it('after the claim deadline, unclaimed open slots roll over into the availability', async () => {
    const { anchor } = (await read(PAST_DEADLINE)).body;

    expect(anchor).toEqual({
      unassignedAnchorSlots: 3,
      rolledOverOpenSlots: 2,
      queuedSlots: 0,
      availableSlots: 5,
    });
  });

  it('without a species the preview is null and the tree counts still show', async () => {
    const { estimate } = (await read(NO_SPECIES)).body;

    expect(estimate).toMatchObject({
      species: null,
      treeTarget: 5,
      removedTrees: 0,
      treeCount: 5,
      commitmentMonths: 36,
      kgCo2PerYearMature: null,
      yearsToMaturity: null,
      kgPerTree: null,
      averageMaturityBps: null,
      previewAmount: null,
      current: null,
    });
  });
});

describe('GET /api/v1/operator/campaigns/:address the estimate lock and the queue', () => {
  it('a mirrored batch locks the estimate; its method is current while its amount equals the confirmed one', async () => {
    const { estimate, queuedJobs } = (await read(LOCKED)).body;

    expect(estimate.locked).toBe(true);
    expect(estimate.current).toEqual({ amount: '99', label: 'pre-certification', method: METHOD });
    // a set_price job is the campaign's through its batch; another batch's is not
    expect(queuedJobs).toEqual([summary('price', { kind: 'set_price', status: 'pending' })]);
  });

  it('a newer method that the chain has not confirmed is not shown as current', async () => {
    const { estimate } = (await read(STALE)).body;

    expect(estimate.current).toEqual({ amount: '50', label: 'pre-certification', method: null });
  });

  it('shows at most the newest 20 queued jobs', async () => {
    const { queuedJobs } = (await read(BUSY)).body;

    expect(queuedJobs).toHaveLength(20);
    expect(queuedJobs[0].id).toBe(jobIds['busy20']);
    expect(queuedJobs.map(({ id }: { id: string }) => id)).not.toContain(jobIds['busy0']);
  });
});

describe('GET /api/v1/operator/campaigns/:address refuses', () => {
  it.each([
    { name: 'a malformed address', campaign: '0x12', status: 400, code: 'invalid_path' },
    { name: 'an unknown campaign', campaign: address(99), status: 404, code: 'not_found' },
    { name: 'a donor', campaign: ROOTS, userId: ALEX, status: 403, code: 'forbidden_role' },
  ])('$name answers $status $code', async ({ campaign, userId = RAKA, status, code }) => {
    const response = await read(campaign, userId);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  it('chain time that cannot be read answers 503 service_unavailable', async () => {
    const down = testApi(test.database, privy, {
      chainNow: async () => {
        throw new HttpRequestError({ url: 'http://127.0.0.1:8545' });
      },
    });

    expect((await read(ROOTS, RAKA, down)).status).toBe(503);
  });
});
