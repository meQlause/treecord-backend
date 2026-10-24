// Testnet faucet jobs (not frozen: added after ADR-021). The API queues them when a profile's wallet is first stored,
// the worker's operator lane sends them; both validate with this one schema.
import { z } from 'zod';
import { lowercaseAddressSchema, uintStringSchema } from '../../generated/frozen/schemas.js';

/** `faucet_eth`: a plain transfer of `amount` wei; `faucet_usdc`: MockUSDC.mint(to, amount) in USDC base units. */
export const faucetJobPayloadSchema = z.object({
  to: lowercaseAddressSchema,
  amount: uintStringSchema,
});

const ANVIL = 31_337;
const BASE_SEPOLIA = 84_532;

/** The chains that may run the faucet: anvil and Base Sepolia, where the USDC is the mintable mock. */
export const FAUCET_CHAINS: readonly number[] = [ANVIL, BASE_SEPOLIA];
