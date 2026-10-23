import { createPublicClient, http, type PublicClient } from 'viem';

/** ADR-010: chain reads are bounded by RPC_TIMEOUT_MS (phases.md D-6). */
export const createChainClient = (rpcUrl: string, timeoutMs: number): PublicClient =>
  createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs }) });
