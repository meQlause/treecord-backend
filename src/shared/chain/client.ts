import {
  BaseError,
  createPublicClient,
  http,
  HttpRequestError,
  TimeoutError,
  type PublicClient,
} from 'viem';

/** ADR-010: a chain read is bounded by RPC_TIMEOUT_MS (phases.md D-6) and never retried inside a request, so a dead
 *  RPC costs one timeout, not four. */
export const createChainClient = (rpcUrl: string, timeoutMs: number): PublicClient =>
  createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }) });

/** ADR-010: the RPC could not be reached or did not answer in time; the request answers 503, never 500. */
export const isChainUnavailable = (error: unknown): boolean =>
  error instanceof BaseError &&
  error.walk((cause) => cause instanceof HttpRequestError || cause instanceof TimeoutError) !==
    null;
