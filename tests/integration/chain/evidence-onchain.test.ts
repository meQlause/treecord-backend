import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import request from 'supertest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { campaignAbi, campaignFactoryAbi } from '../../../src/generated/frozen/abis/index.js';
import { DEFAULT_SPLIT } from '../../../src/generated/frozen/constants.js';
import { geohashToBytes8, type EvidencePayload } from '../../../src/generated/frozen/evidence.js';
import { chainClock } from '../../../src/shared/chain/clock.js';
import { testApi, type TestApi } from '../../helpers/api.js';
import {
  CONTAINER_START_MS,
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.js';
import { fakePrivy } from '../../helpers/fake-privy.js';
import { startMinio, type TestMinio } from '../../helpers/minio.js';
import { planterPhone, sha256Hex, type Phone } from '../../helpers/planter-phone.js';
import { aProfile, theSpecies } from '../../fixtures/mirror.js';

// phases.md B5b, ADR-001: a planting and a check-in submitted through this API are scored by the B2 worker, attested
// and land on a fresh anvil, the worker reading the jobs the API wrote. The worker and its chain helper come from the
// sibling treecord-backend checkout (ADR-001 keeps them there); the test fails, never skips, when it is missing.
const WORKER_REPO = fileURLToPath(new URL('../../../../treecord-backend/', import.meta.url));
const ANVIL_PORT = 8548;
const TIME_UNIT = 60n;
const JAKARTA = { lat: -6.2, lon: 106.816666 };
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';
const ONCHAIN_TIMEOUT_MS = 90_000;

type LocalChain = {
  rpcUrl: string;
  client: PublicClient;
  deployment: {
    chainId: number;
    campaignFactory: Address;
    usdc: Address;
    verificationGateway: Address;
  };
  stop: () => Promise<void>;
};

type WorkerInstance = { start: () => void; stop: () => Promise<void> };

const fromWorkerRepo = async <Module>(path: string): Promise<Module> =>
  (await import(pathToFileURL(join(WORKER_REPO, path)).href)) as Module;

const mockUsdcAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

let test: TestDatabase;
let minio: TestMinio;
let chain: LocalChain;
let worker: WorkerInstance | undefined;
let api: TestApi;
let phone: Phone;
let keys: Record<'operator' | 'donor' | 'relayer' | 'attester', Hex>;

/** Polls until `check` finds a row, or fails after `timeoutMs`. */
const waitFor = async <Row>(
  label: string,
  check: () => Promise<Row | undefined>,
  timeoutMs = ONCHAIN_TIMEOUT_MS,
) => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const found = await check();

    if (found !== undefined) {
      return found;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
};

const firstRow = async <Row>(query: ReturnType<typeof sql<Row>>) =>
  (await query.execute(test.database)).rows[0];

/** The B2 worker, in process, on this test's database, MinIO and chain, with the mock AI (ADR-018). */
const startWorker = async (): Promise<WorkerInstance> => {
  const pipeline = await fromWorkerRepo<{
    createPool: (url: string, max: number, log: object) => unknown;
    createStorage: (config: object) => unknown;
    Attester: new (key: Hex, chainId: number, gateway: Address) => unknown;
    MockAiClient: new () => unknown;
  }>('packages/pipeline/dist/index.js');
  const { Worker } = await fromWorkerRepo<{ Worker: new (options: object) => WorkerInstance }>(
    'apps/worker/src/worker.ts',
  );
  const { createChainClients } = await fromWorkerRepo<{
    createChainClients: (options: object) => unknown;
  }>('apps/worker/src/chain.ts');
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const db = pipeline.createPool(test.postgres.getConnectionUri(), 5, silent);

  return new Worker({
    mode: 'all',
    db,
    clients: createChainClients({
      rpcUrl: chain.rpcUrl,
      chainId: chain.deployment.chainId,
      operatorKey: keys.operator,
      relayerKey: keys.relayer,
      pollingIntervalMs: 100,
    }),
    deployment: chain.deployment,
    log: silent,
    workerId: `api-e2e:${process.pid}`,
    scoreDeps: {
      db,
      storage: pipeline.createStorage(minio.config),
      attester: new pipeline.Attester(
        keys.attester,
        chain.deployment.chainId,
        chain.deployment.verificationGateway,
      ),
      chainNow: async () => Number((await chain.client.getBlock({ blockTag: 'latest' })).timestamp),
      ai: new pipeline.MockAiClient(),
      log: silent,
    },
    indexer: { pollMs: 250, cursorName: `indexer:api-e2e:${randomUUID()}`, confirmations: 2 },
    relayer: { pollMs: 250, receiptTimeoutMs: 20_000 },
    scheduler: { intervalMs: 3_600_000, maxCallsPerRun: 1_000 },
  });
};

/** A campaign of 10 trees around Jakarta, its metadata from the API's table, funded so it is Active. */
const activeCampaign = async (): Promise<Address> => {
  const transport = http(chain.rpcUrl);
  const operator = createWalletClient({
    account: privateKeyToAccount(keys.operator),
    chain: foundry,
    transport,
  });
  const send = async (hash: Promise<Hex>) =>
    chain.client.waitForTransactionReceipt({ hash: await hash });
  const owner = await aProfile(test.database, 'operator', 'did:privy:cm2raka0000000000000000');
  const metadata = await firstRow(sql<{
    id: string;
  }>`insert into public.campaign_metadata (creator_profile_id,
      title, species_code, region_name, region_center_lat, region_center_lon, region_radius_m)
    values (${owner}, 'Mahogany for Jakarta', 'SWIETENIA_MACROPHYLLA', 'Jakarta', ${JAKARTA.lat}, ${JAKARTA.lon}, 5000)
    returning id`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const created = await send(
    operator.writeContract({
      address: chain.deployment.campaignFactory,
      abi: campaignFactoryAbi,
      functionName: 'createCampaign',
      args: [
        {
          creator: operator.account.address,
          metadataURI: `http://localhost:3000/api/campaigns/metadata/${metadata?.id}`,
          speciesCode: stringToHex('SWIETENIA_MACROPHYLLA', { size: 32 }),
          regionGeohash: geohashToBytes8('qqguwvt'),
          regionRadiusM: 5000,
          treeTarget: 10,
          anchorBps: 2000,
          perPlanterCap: 3,
          fundingTarget: 20_000_000n,
          fundingDeadline: now + 20n * TIME_UNIT,
          claimDeadline: now + 40n * TIME_UNIT,
          commitmentUnits: 36,
          timeUnit: TIME_UNIT,
          split: DEFAULT_SPLIT,
        },
      ],
    }),
  );
  const [event] = parseEventLogs({
    abi: campaignFactoryAbi,
    eventName: 'CampaignCreated',
    logs: created.logs,
  });
  const campaign = (event?.args.campaign ?? '0x').toLowerCase() as Address;

  await fund(campaign);

  return campaign;
};

/** The donor mints test USDC and funds the whole target, which activates the campaign. */
const fund = async (campaign: Address): Promise<void> => {
  const donor = createWalletClient({
    account: privateKeyToAccount(keys.donor),
    chain: foundry,
    transport: http(chain.rpcUrl),
  });
  const send = async (hash: Promise<Hex>) =>
    chain.client.waitForTransactionReceipt({ hash: await hash });

  await send(
    donor.writeContract({
      address: chain.deployment.usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [donor.account.address, 20_000_000n],
    }),
  );
  await send(
    donor.writeContract({
      address: chain.deployment.usdc,
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [campaign, 20_000_000n],
    }),
  );
  await send(
    donor.writeContract({
      address: campaign,
      abi: campaignAbi,
      functionName: 'contribute',
      args: [20_000_000n],
    }),
  );
  await waitFor('the campaign mirrored as Active', () =>
    firstRow(sql`select 1 from public.campaigns where address = ${campaign} and status = 'active'`),
  );
};

/** Records, uploads, signs and submits through the API, then waits for the worker to land it on chain. */
const submitAndLand = async (
  target: Record<string, unknown>,
  payload: Omit<EvidencePayload, 'videoSha256' | 'deviceKey'>,
) => {
  const video = randomBytes(256);
  const submissionId = await phone.record(target, video);
  const signed = await phone.sign({
    ...payload,
    videoSha256: sha256Hex(video),
    deviceKey: phone.deviceKey,
  });
  const submitted = await request(api.app)
    .post(`/api/v1/evidence/${submissionId}/submit`)
    .set(await api.signedIn(SARI))
    .send(signed);

  expect(submitted.status).toBe(202);

  return waitFor(`submission ${submissionId} on chain`, () =>
    firstRow(sql<{
      tx_hash: string;
      tree_id: string | null;
    }>`select tx_hash, tree_id::text from public.submissions
      where id = ${submissionId} and status = 'onchain'`),
  );
};

/** The operator relays a slot claim for Sari; once the indexer mirrors slot 3, her slot list issues its tag. */
const claimedSlotTag = async (campaign: Address): Promise<string> => {
  // the operator relays a slot claim for Sari; the indexer mirrors her open slot 3
  await sql`insert into public.relayer_jobs (kind, payload)
    values ('claim', ${JSON.stringify({ campaign, planter: SARI_WALLET, count: 1 })}::jsonb)`.execute(
    test.database,
  );
  await waitFor('the claimed slot', () =>
    firstRow(sql`select 1 from public.slots where campaign_address = ${campaign} and slot_id = 3
      and planter_address = ${SARI_WALLET}`),
  );

  const slots = await request(api.app)
    .get('/api/v1/planter/slots')
    .set(await api.signedIn(SARI));

  return slots.body.items[0].tag.code as string;
};

beforeAll(async () => {
  const localChain = await fromWorkerRepo<{
    findAnvil: () => string | null;
    artifactsBuilt: () => boolean;
    startLocalChain: (anvil: string, port: number) => Promise<LocalChain>;
    ANVIL_KEYS: typeof keys;
  }>('apps/worker/src/test/local-chain.ts');
  const anvil = localChain.findAnvil();

  if (!existsSync(WORKER_REPO) || anvil === null || !localChain.artifactsBuilt()) {
    throw new Error('needs ../treecord-backend with built contracts and Foundry (anvil)');
  }

  keys = localChain.ANVIL_KEYS;
  [test, minio, chain] = await Promise.all([
    startMigratedDatabase(),
    startMinio(),
    localChain.startLocalChain(anvil, ANVIL_PORT),
  ]);
  await theSpecies(test.database);
  api = testApi(test.database, await fakePrivy(), {
    chainNow: chainClock(createPublicClient({ chain: foundry, transport: http(chain.rpcUrl) })),
    clock: () => new Date(),
    env: minio.config,
  });
  worker = await startWorker();
  worker.start();
  await aProfile(test.database, 'planter', SARI, SARI_WALLET);
  phone = await planterPhone(api, SARI);
}, CONTAINER_START_MS);

afterAll(async () => {
  await worker?.stop();
  await Promise.all([chain?.stop(), test?.stop(), minio?.stop()]);
}, 60_000);

describe('evidence through the API, scored by the worker, on anvil (ADR-001)', () => {
  it('a planting and its month-3 check-in each reach onchain', async () => {
    const campaign = await activeCampaign();
    const tag = await claimedSlotTag(campaign);

    const signedCommon = { v: 1 as const, campaign, ...JAKARTA, acc: 6, challenge: null, tag };
    const planting = await submitAndLand(
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
      firstRow(sql<{
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
      transport: http(chain.rpcUrl),
    });

    await anvil.setNextBlockTimestamp({ timestamp: opensAt + 5n });
    await anvil.mine({ blocks: 1 });

    const checkIn = await submitAndLand(
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
      firstRow(sql<{ amount: string }>`select amount::text from public.milestone_payouts
        where tree_id = ${tree.tree_id} and milestone = 1`),
    );

    expect(checkIn.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(payout.amount)).toBeGreaterThan(0n);
  }, 240_000);
});
