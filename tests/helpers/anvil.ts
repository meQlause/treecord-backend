import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createTestClient, http, publicActions, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';

const ANVIL_PORT = 8545;
const MS_PER_SECOND = 1000;

export type TestChain = {
  /** A read client on the chain, as the API's chain clock uses one. */
  client: PublicClient;
  /** Mines a block at `time`, which becomes the latest block's timestamp (chain time only moves forward). */
  mineAt: (time: Date) => Promise<void>;
  stop: () => Promise<void>;
};

/** A fresh anvil (the compose image) whose chain time starts at `genesis`, mining only when told (phases.md: tests
 *  run on a fresh local chain). */
export const startAnvil = async (genesis: Date): Promise<TestChain> => {
  const container: StartedTestContainer = await new GenericContainer(
    'ghcr.io/foundry-rs/foundry:v1.7.1',
  )
    .withEntrypoint(['anvil'])
    .withCommand([
      '--host',
      '0.0.0.0',
      '--chain-id',
      '31337',
      '--timestamp',
      String(genesis.getTime() / MS_PER_SECOND),
    ])
    .withExposedPorts(ANVIL_PORT)
    .withWaitStrategy(Wait.forLogMessage('Listening on'))
    .start();
  const url = `http://${container.getHost()}:${container.getMappedPort(ANVIL_PORT)}`;
  const client = createTestClient({ chain: foundry, mode: 'anvil', transport: http(url) }).extend(
    publicActions,
  );

  return {
    client: client as unknown as PublicClient,
    mineAt: async (time) => {
      await client.setNextBlockTimestamp({ timestamp: BigInt(time.getTime() / MS_PER_SECOND) });
      await client.mine({ blocks: 1 });
    },
    stop: async () => {
      await container.stop();
    },
  };
};
