import { BPS } from '../generated/frozen/constants.js';

const BPS_BIG = BigInt(BPS);

/** floor(part × 10000 / whole) over decimal strings as bigint (REG-001); null when there is no whole yet. */
export const ratioBps = (part: string, whole: string | null): number | null =>
  whole === null || whole === '0' ? null : Number((BigInt(part) * BPS_BIG) / BigInt(whole));
