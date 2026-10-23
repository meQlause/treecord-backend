import type { Hex, PublicClient } from 'viem';

const MS_PER_SECOND = 1000;

/** ADR-015: "now" for every deadline is the latest block's timestamp, never the server clock. */
export const chainClock = (chain: PublicClient) => async (): Promise<Date> =>
  new Date(Number((await chain.getBlock({ blockTag: 'latest' })).timestamp) * MS_PER_SECOND);

/** The timestamp of one block, for a mirror row the indexer stored without it (carbon_batches.issued_at). */
export const blockTime =
  (chain: PublicClient) =>
  async (blockNumber: string): Promise<Date> =>
    new Date(
      Number((await chain.getBlock({ blockNumber: BigInt(blockNumber) })).timestamp) *
        MS_PER_SECOND,
    );

/** FR-182: the latest block's number and hash, from the chain itself (never the mirror), the seed of an audit sample. */
export const latestBlock =
  (chain: PublicClient) => async (): Promise<{ number: string; hash: Hex }> => {
    const block = await chain.getBlock({ blockTag: 'latest' });

    return { number: block.number.toString(), hash: block.hash };
  };
