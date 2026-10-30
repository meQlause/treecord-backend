import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import request from 'supertest';
import {
  createTestClient,
  encodeAbiParameters,
  http,
  parseAbiParameters,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { campaignAbi } from '../../../src/generated/frozen/abis/index.js';
import { createWorkerDatabase } from '../../../src/shared/db/worker-database.js';
import { Indexer } from '../../../src/worker/indexer/indexer.service.js';
import { Metrics } from '../../../src/worker/metrics.js';
import { aProfile } from '../../fixtures/mirror.js';
import { ANVIL_KEYS } from '../../helpers/chain.js';
import { CONTAINER_START_MS } from '../../helpers/database.js';
import {
  activeCampaign,
  claimedTag,
  mined,
  plantedTree,
  startOnchain,
  TIME_UNIT,
  waitFor,
  walletOf,
  type Onchain,
} from '../../helpers/onchain.js';
import { planterPhone } from '../../helpers/planter-phone.js';

// FR-243, FR-244, ADR-022: TreecordKeeper forfeits a closed window for a stand-in Chainlink Forwarder; an indexer
// watching the keeper mirrors Enforced once, and the tree page credits Chainlink for that forfeit only.
const ANVIL_PORT = 8553;
const SARI = 'did:privy:cm2sari0000000000000000';
const SARI_WALLET = '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e';
const RAKA = 'did:privy:cm2raka0000000000000000';
const WORKFLOW_ID = `0x${'7'.repeat(64)}` as Hex;
const WORKFLOW_OWNER: Address = '0x00000000000000000000000000000000000000f1';
const KEEPER_ARTIFACT = new URL(
  '../../../../contracts/out/TreecordKeeper.sol/TreecordKeeper.json',
  import.meta.url,
);
const TASKS = parseAbiParameters(
  '(uint8 kind, address campaign, uint256 treeId, uint8 milestone)[]',
);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let stack: Onchain;
let campaign: Address;
let keeper: Address;
let keeperBlock: bigint;
let keeperAbi: Abi;

const deployKeeper = async (): Promise<void> => {
  const { abi, bytecode } = JSON.parse(readFileSync(KEEPER_ARTIFACT, 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  const admin = walletOf(stack, ANVIL_KEYS.deployer);
  const receipt = await mined(
    stack,
    admin.deployContract({
      abi,
      bytecode: bytecode.object,
      args: [stack.chain.deployment.treecordRoles],
    } as never),
  );

  keeperAbi = abi;
  keeper = receipt.contractAddress as Address;
  keeperBlock = receipt.blockNumber;
  await mined(
    stack,
    admin.writeContract({
      address: keeper,
      abi,
      functionName: 'configure',
      args: [walletOf(stack, stack.keys.donor).account.address, WORKFLOW_ID, WORKFLOW_OWNER],
    } as never),
  );
};

/** Moves chain time just past the close of `milestone`'s window (window = 1 unit, milestone 1 due at 3, 2 at 6). */
const pastClose = async (treeId: string, dueUnits: bigint): Promise<void> => {
  const tree = await stack.row(
    sql<{ planted_at: Date }>`select planted_at from public.trees where tree_id = ${treeId}`,
  );
  const anvil = createTestClient({
    chain: foundry,
    mode: 'anvil',
    transport: http(stack.chain.rpcUrl),
  });

  await anvil.setNextBlockTimestamp({
    timestamp:
      BigInt(Math.floor(tree!.planted_at.getTime() / 1000)) + (dueUnits + 1n) * TIME_UNIT + 5n,
  });
  await anvil.mine({ blocks: 1 });
};

/** An indexer that watches the keeper, from the keeper's block, until it reaches the head. */
const indexKeeper = async (cursorName: string): Promise<void> => {
  const db = createWorkerDatabase({
    url: stack.test.url,
    poolMax: 2,
    onConnectionError: () => undefined,
  });
  const indexer = new Indexer({
    db,
    client: stack.chain.client,
    deployment: stack.chain.deployment,
    keeperAddress: keeper,
    log: silent,
    metrics: new Metrics(),
    cursorName,
    startBlock: keeperBlock,
    confirmations: 0,
  });

  try {
    while (!(await indexer.tick())?.caughtUp) {
      // next chunk
    }
  } finally {
    await db.destroy();
  }
};

/** The stand-in Forwarder reports one forfeit task to the keeper; the receipt. */
const forfeitByKeeper = async (treeId: string, milestone: number) =>
  mined(
    stack,
    walletOf(stack, stack.keys.donor).writeContract({
      address: keeper,
      abi: keeperAbi,
      functionName: 'onReport',
      args: [
        `${WORKFLOW_ID}${'00'.repeat(10)}${WORKFLOW_OWNER.slice(2)}`,
        encodeAbiParameters(TASKS, [[{ kind: 0, campaign, treeId: BigInt(treeId), milestone }]]),
      ],
      gas: 1_000_000n,
    } as never),
  );

/** Anyone, here the scheduler's role, forfeits directly: no keeper, so no credit. */
const forfeitDirectly = async (treeId: string, milestone: number) =>
  mined(
    stack,
    walletOf(stack, stack.keys.donor).writeContract({
      address: campaign,
      abi: campaignAbi,
      functionName: 'forfeitMilestone',
      args: [BigInt(treeId), milestone],
    }),
  );

const enforcements = async (treeId: string) =>
  (
    await stack.row(sql<{ n: number }>`select count(*)::int as n from public.chainlink_enforcements
      where tree_id = ${treeId}`)
  )?.n;

/** Rows for the tree after the keeper indexer runs, then after a second indexer replays the same blocks. */
const indexedTwice = async (treeId: string): Promise<(number | undefined)[]> => {
  await indexKeeper('indexer:keeper-test');
  const first = await enforcements(treeId);

  await indexKeeper('indexer:keeper-test-replay');

  return [first, await enforcements(treeId)];
};

beforeAll(async () => {
  stack = await startOnchain(ANVIL_PORT);
  campaign = await activeCampaign(stack, await aProfile(stack.test.database, 'operator', RAKA));
  await aProfile(stack.test.database, 'planter', SARI, SARI_WALLET);
  await deployKeeper();
}, CONTAINER_START_MS);

afterAll(async () => {
  await stack?.stop();
}, 60_000);

describe('TreecordKeeper on anvil, mirrored and shown (FR-243, FR-244)', () => {
  it('credits Chainlink for the forfeit the keeper sent, once, and not for a direct one', async () => {
    const sari = { phone: await planterPhone(stack.api, SARI), userId: SARI };
    const treeId = await plantedTree(
      stack,
      sari,
      campaign,
      await claimedTag(stack, sari, campaign),
    );

    await pastClose(treeId, 3n);
    const byKeeper = await forfeitByKeeper(treeId, 1);

    await pastClose(treeId, 6n);
    await forfeitDirectly(treeId, 2);

    expect(await indexedTwice(treeId)).toEqual([1, 1]);

    await waitFor('both forfeits mirrored', () =>
      stack.row(sql`select 1 from public.milestone_forfeits where tree_id = ${treeId}
        group by tree_id having count(*) = 2`),
    );
    const page = await request(stack.api.app).get(`/api/v1/trees/${treeId}`);

    expect(page.status).toBe(200);
    expect(page.body.milestones[1]).toMatchObject({
      status: 'forfeited',
      enforcedTxHash: byKeeper.transactionHash,
    });
    expect(page.body.milestones[2]).toMatchObject({ status: 'forfeited', enforcedTxHash: null });
    expect(page.body.tree.removalEnforcedTxHash).toBeNull();
  }, 300_000);
});
