import { randomBytes, randomUUID } from 'node:crypto';
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
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { expect } from 'vitest';
import { campaignAbi, campaignFactoryAbi } from '../../src/generated/frozen/abis/index.js';
import { DEFAULT_SPLIT } from '../../src/generated/frozen/constants.js';
import { geohashToBytes8, type EvidencePayload } from '../../src/generated/frozen/evidence.js';
import { Attester } from '../../src/generated/frozen/attester.js';
import { chainClock } from '../../src/shared/chain/clock.js';
import { createChainClients } from '../../src/shared/chain/wallets.js';
import { createWorkerDatabase } from '../../src/shared/db/worker-database.js';
import { createWorkerStorage } from '../../src/shared/storage/storage.js';
import { createWorker } from '../../src/worker/create-worker.js';
import { MockAiClient } from '../../src/worker/scoring/mock-ai-client.js';
import { theSpecies } from '../fixtures/mirror.js';
import { testApi, type TestApi } from './api.js';
import {
  ANVIL_KEYS,
  artifactsBuilt,
  findAnvil,
  startLocalChain,
  type LocalChain,
} from './chain.js';
import { startMigratedDatabase, type TestDatabase } from './database.js';
import { fakePrivy } from './fake-privy.js';
import { startMinio, type TestMinio } from './minio.js';
import { sha256Hex, type Phone } from './planter-phone.js';

// ADR-001, ADR-021: this API on a fresh anvil with the worker in process, reading the jobs the API writes. The
// contracts come from the root's contracts/ submodule; a test using this fails, never skips, when they are not built.
const ONCHAIN_TIMEOUT_MS = 90_000;

/** One time unit is 60 s here, so a month of the commitment passes in a minute of chain time. */
export const TIME_UNIT = 60n;

export const JAKARTA = { lat: -6.2, lon: 106.816666 };

type AnvilKeys = Record<'operator' | 'donor' | 'relayer' | 'attester', Hex>;

type WorkerInstance = { start: () => void; stop: () => Promise<void> };

export type Onchain = {
  test: TestDatabase;
  minio: TestMinio;
  chain: LocalChain;
  api: TestApi;
  keys: AnvilKeys;
  /** The query's first row, or undefined. */
  row: <Row>(query: ReturnType<typeof sql<Row>>) => Promise<Row | undefined>;
  stop: () => Promise<void>;
};

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

/** Polls until `check` finds a row, or fails after `timeoutMs`. */
export const waitFor = async <Row>(
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

/** Both answers to a double submit: one 202 and one 200 replay, naming the same job (ADR-009). */
export const oneJob = (responses: { status: number; body: { job: { id: string } } }[]): string => {
  const [first, second] = responses;

  expect(responses.map(({ status }) => status).sort()).toEqual([200, 202]);
  expect(first?.body.job.id).toBe(second?.body.job.id);

  return first?.body.job.id ?? '';
};

/** Waits for the worker to confirm a job on chain; its transaction hash. */
export const confirmed = (stack: Onchain, jobId: string) =>
  waitFor(`job ${jobId} confirmed`, () =>
    stack.row(sql<{ tx_hash: string }>`select tx_hash from public.relayer_jobs
      where id = ${jobId} and status = 'confirmed'`),
  );

/** A wallet on the stack's anvil for one of its keys. */
export const walletOf = (stack: Pick<Onchain, 'chain'>, key: Hex) =>
  createWalletClient({
    account: privateKeyToAccount(key),
    chain: foundry,
    transport: http(stack.chain.rpcUrl),
  });

/** Waits for a sent transaction's receipt. */
export const mined = async (stack: Pick<Onchain, 'chain'>, sent: Promise<Hex>) =>
  stack.chain.client.waitForTransactionReceipt({ hash: await sent });

/** The worker on this stack's database, MinIO and chain, with the mock AI (ADR-018). */
const startWorker = ({
  test,
  minio,
  chain,
  keys,
}: Omit<Onchain, 'api' | 'row' | 'stop'>): WorkerInstance & {
  db: { destroy: () => Promise<void> };
} => {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const db = createWorkerDatabase({
    url: test.postgres.getConnectionUri(),
    poolMax: 5,
    onConnectionError: () => undefined,
  });
  const clients = createChainClients({
    rpcUrl: chain.rpcUrl,
    chainId: chain.deployment.chainId,
    operatorKey: keys.operator,
    relayerKey: keys.relayer,
    pollingIntervalMs: 100,
  });
  const worker = createWorker({
    mode: 'all',
    db,
    clients,
    deployment: chain.deployment,
    log: silent,
    workerId: `api-e2e:${process.pid}`,
    scoreDeps: {
      db,
      storage: createWorkerStorage({ S3_TIMEOUT_MS: 15_000, ...minio.config }),
      attester: new Attester(
        keys.attester,
        chain.deployment.chainId,
        chain.deployment.verificationGateway,
      ),
      chainNow: async () => Number((await chain.client.getBlock({ blockTag: 'latest' })).timestamp),
      ai: new MockAiClient(),
      log: silent,
    },
    tuning: {
      indexerPollMs: 250,
      relayerPollMs: 250,
      schedulerIntervalMs: 3_600_000,
      indexer: { cursorName: `indexer:api-e2e:${randomUUID()}`, confirmations: 2 },
      receiptTimeoutMs: 20_000,
      maxCallsPerRun: 1_000,
    },
  });

  return { start: () => worker.start(), stop: () => worker.stop(), db };
};

/** PostgreSQL, MinIO and anvil on `anvilPort`, the species seeded, the API on chain time and the worker running. */
export const startOnchain = async (anvilPort: number): Promise<Onchain> => {
  const anvil = findAnvil();

  if (anvil === null || !artifactsBuilt()) {
    throw new Error(
      'needs Foundry (anvil) and the contracts built: cd ../contracts && npm ci && forge build',
    );
  }

  const keys = ANVIL_KEYS;
  const [test, minio, chain] = await Promise.all([
    startMigratedDatabase(),
    startMinio(),
    startLocalChain(anvil, anvilPort),
  ]);
  const worker = startWorker({ test, minio, chain, keys });

  await theSpecies(test.database);
  worker.start();

  return {
    test,
    minio,
    chain,
    keys,
    api: testApi(test.database, await fakePrivy(), {
      chainNow: chainClock(createPublicClient({ chain: foundry, transport: http(chain.rpcUrl) })),
      clock: () => new Date(),
      // the attester key holds ATTESTER_ROLE on the local deployment, so the gateway accepts what the API signs
      env: { ...minio.config, ATTESTER_PRIVATE_KEY: keys.attester },
    }),
    row: async (query) => (await query.execute(test.database)).rows[0],
    stop: async () => {
      await worker.stop();
      await worker.db.destroy();
      await Promise.all([chain.stop(), test.stop(), minio.stop()]);
    },
  };
};

/** The donor mints test USDC and funds the whole target, which activates the campaign. */
const fund = async (stack: Onchain, campaign: Address): Promise<void> => {
  const donor = walletOf(stack, stack.keys.donor);

  await mined(
    stack,
    donor.writeContract({
      address: stack.chain.deployment.usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [donor.account.address, 20_000_000n],
    }),
  );
  await mined(
    stack,
    donor.writeContract({
      address: stack.chain.deployment.usdc,
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [campaign, 20_000_000n],
    }),
  );
  await mined(
    stack,
    donor.writeContract({
      address: campaign,
      abi: campaignAbi,
      functionName: 'contribute',
      args: [20_000_000n],
    }),
  );
  await waitFor('the campaign mirrored as Active', () =>
    stack.row(
      sql`select 1 from public.campaigns where address = ${campaign} and status = 'active'`,
    ),
  );
};

/** A campaign of 10 trees around Jakarta (two anchors, so open slots start at 3, three per planter), its metadata
 *  saved by `creatorProfileId`, funded by the donor key so it is Active. */
export const activeCampaign = async (
  stack: Onchain,
  creatorProfileId: string,
): Promise<Address> => {
  const metadata = await stack.row(sql<{
    id: string;
  }>`insert into public.campaign_metadata (creator_profile_id,
      title, species_code, region_name, region_center_lat, region_center_lon, region_radius_m)
    values (${creatorProfileId}, 'Mahogany for Jakarta', 'SWIETENIA_MACROPHYLLA', 'Jakarta', ${JAKARTA.lat},
      ${JAKARTA.lon}, 5000)
    returning id`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const operator = walletOf(stack, stack.keys.operator);
  const created = await mined(
    stack,
    operator.writeContract({
      address: stack.chain.deployment.campaignFactory,
      abi: campaignFactoryAbi,
      functionName: 'createCampaign',
      args: [
        {
          creator: operator.account.address,
          metadataURI: `http://localhost:3001/api/v1/campaigns/metadata/${metadata?.id}`,
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

  await fund(stack, campaign);

  return campaign;
};

/** Records, uploads, signs and submits through the API as the planter, then waits for the worker to land it. */
export const submitAndLand = async (
  stack: Onchain,
  planter: { phone: Phone; userId: string },
  target: Record<string, unknown>,
  payload: Omit<EvidencePayload, 'videoSha256' | 'deviceKey'>,
) => {
  const video = randomBytes(256);
  const submissionId = await planter.phone.record(target, video);
  const signed = await planter.phone.sign({
    ...payload,
    videoSha256: sha256Hex(video),
    deviceKey: planter.phone.deviceKey,
  });
  const submitted = await request(stack.api.app)
    .post(`/api/v1/evidence/${submissionId}/submit`)
    .set(await stack.api.signedIn(planter.userId))
    .send(signed);

  expect(submitted.status).toBe(202);

  return waitFor(`submission ${submissionId} on chain`, () =>
    stack.row(sql<{
      tx_hash: string;
      tree_id: string | null;
    }>`select tx_hash, tree_id::text from public.submissions
      where id = ${submissionId} and status = 'onchain'`),
  );
};

/** A planter of the stack: their phone (device key) and their sign-in. */
export type StackPlanter = { phone: Phone; userId: string };

// the mock AI scores liveness 0.75 for a payload carrying this challenge, which the policy sends to review
// (ai-client.ts MOCK_AI_HOOKS); no challenge is open, so the API's challenge check passes whatever is carried
const REVIEW_CHALLENGE = 'REVIEW-LIVENESS';

/** The planter claims one open slot (slot 3, the first after the two anchors) through the API; its tag once the
 *  indexer mirrors the slot and the slot list issues the tag. */
export const claimedTag = async (
  stack: Onchain,
  planter: StackPlanter,
  campaign: Address,
): Promise<string> => {
  const claimed = await request(stack.api.app)
    .post(`/api/v1/campaigns/${campaign}/claims`)
    .set(await stack.api.signedIn(planter.userId))
    .send({ count: 1 });

  await confirmed(stack, claimed.body.job.id as string);
  await waitFor('the claimed slot', () =>
    stack.row(sql`select 1 from public.slots where campaign_address = ${campaign} and slot_id = 3`),
  );

  const slots = await request(stack.api.app)
    .get('/api/v1/planter/slots')
    .set(await stack.api.signedIn(planter.userId));

  return slots.body.items[0].tag.code as string;
};

/** Plants slot 3 and moves chain time into the tree's month-3 window; the tree id. */
export const plantedTree = async (
  stack: Onchain,
  planter: StackPlanter,
  campaign: Address,
  tag: string,
): Promise<string> => {
  await submitAndLand(
    stack,
    planter,
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
export const checkInForReview = async (
  stack: Onchain,
  planter: StackPlanter,
  { campaign, treeId, tag }: { campaign: Address; treeId: string; tag: string },
): Promise<string> => {
  const video = randomBytes(256);
  const submissionId = await planter.phone.record(
    { kind: 'ALIVE', campaign, treeId, milestone: 1, contentType: 'video/mp4' },
    video,
  );
  const signed = await planter.phone.sign({
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
    deviceKey: planter.phone.deviceKey,
  });
  const submitted = await request(stack.api.app)
    .post(`/api/v1/evidence/${submissionId}/submit`)
    .set(await stack.api.signedIn(planter.userId))
    .send(signed);

  expect(submitted.status).toBe(202);
  await waitFor('the check-in in review', () =>
    stack.row(
      sql`select 1 from public.submissions where id = ${submissionId} and status = 'needs_review'`,
    ),
  );

  return submissionId;
};
