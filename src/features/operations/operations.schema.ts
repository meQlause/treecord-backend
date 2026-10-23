import { z } from 'zod';
import { tonnesSchema } from '../../generated/frozen/schemas.js';
import { addressParam } from '../../shared/http/params.js';

const MAX_COUNT = 65_535;
const MAX_UINT256 = 2n ** 256n - 1n;

/** operations §2 (FR-173): a planter wallet, stored lowercase, and a slot count. */
export const anchorAssignmentSchema = z.strictObject({
  planter: addressParam,
  count: z.number().int().min(1).max(MAX_COUNT),
});

export type AnchorAssignmentInput = z.infer<typeof anchorAssignmentSchema>;

/** §3 (FR-174): no manual input at all. */
export const estimateSchema = z.strictObject({});

/** §4 (FR-175): a registry issuance as the operator typed it; tonnes stay a string (REG-001). */
export const issuanceSchema = z.strictObject({
  registry: z.string().trim().min(2).max(64),
  vintage: z.number().int().min(2000).max(2100),
  serialStart: z.string().trim().min(1).max(200),
  serialEnd: z.string().trim().min(1).max(200),
  tonnes: tonnesSchema,
});

export type IssuanceInput = z.infer<typeof issuanceSchema>;

/** §5 (FR-176): USDC base units per tonne, a uint256 decimal string; "0" pauses sales. One check, so BigInt never sees
 *  a string the pattern refused. */
export const priceSchema = z.strictObject({
  usdcPerTonne: z
    .string()
    .refine((value) => /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= MAX_UINT256),
});
