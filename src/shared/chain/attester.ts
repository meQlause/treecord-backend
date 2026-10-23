import type { Hex } from 'viem';
import { getDeployment } from '../../generated/frozen/addresses.js';
import { Attester } from '../../generated/frozen/attester.js';

/** ADR-002, ADR-014: the worker's own attester, signing EIP-712 attestations for this chain's VerificationGateway with
 *  `ATTESTER_PRIVATE_KEY`. It never sends a transaction. */
export const createAttester = (privateKey: Hex, chainId: number): Attester =>
  new Attester(privateKey, chainId, getDeployment(chainId).verificationGateway);
