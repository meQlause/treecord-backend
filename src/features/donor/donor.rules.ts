import { BPS } from '../../generated/frozen/constants.js';

// docs/BE/features/donor.md §2: the card's own maths, on decimal strings as bigint (REG-001).

const BPS_BIG = BigInt(BPS);
const HALF_UP = 2n;

/** FR-073: the donor's share of what was raised, rounded half up so the two-decimal percent is exact. */
export const fundingShareBps = (contributed: string, funded: string): number | null =>
  funded === '0'
    ? null
    : Number(
        (BigInt(contributed) * BPS_BIG * HALF_UP + BigInt(funded)) / (HALF_UP * BigInt(funded)),
      );

/** FR-073: the incentive pool once active; before that, raised × incentivesBps. */
export const planterBudget = (
  incentivePool: string | null,
  funded: string,
  incentivesBps: number,
): string => incentivePool ?? ((BigInt(funded) * BigInt(incentivesBps)) / BPS_BIG).toString();
