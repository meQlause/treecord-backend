import type { PublicClient } from 'viem';

const MS_PER_SECOND = 1000;

/** ADR-015: "now" for every deadline is the latest block's timestamp, never the server clock. */
export const chainClock = (chain: PublicClient) => async (): Promise<Date> =>
  new Date(Number((await chain.getBlock({ blockTag: 'latest' })).timestamp) * MS_PER_SECOND);
