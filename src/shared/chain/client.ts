import { createPublicClient, http, type PublicClient } from 'viem';

export const createChainClient = (rpcUrl: string): PublicClient =>
  createPublicClient({ transport: http(rpcUrl) });
