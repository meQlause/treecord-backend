import { z } from 'zod';
import {
  BPS,
  MILESTONE_DUE_UNITS,
  MILESTONE_SHARES_BPS,
} from '../../generated/frozen/constants.js';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor.js';

// docs/BE/features/campaigns.md §1–§2: the integer maths every screen shares. Money stays a decimal string and is
// computed as bigint, never a JS number (REG-001).

type CampaignStatus = 'funding' | 'active' | 'refunding' | 'completed';

export type Split = {
  incentivesBps: number;
  seedlingsBps: number;
  verificationBps: number;
  reserveBps: number;
  feeBps: number;
};

const DAY_MS = 86_400_000;
const BPS_BIG = BigInt(BPS);

/** floor(funded × 10000 / target); 10000 when funded (funded_within_target). */
export const progressBps = (fundedAmount: string, fundingTarget: string): number =>
  fundingTarget === '0' ? 0 : Number((BigInt(fundedAmount) * BPS_BIG) / BigInt(fundingTarget));

/** The contract's markRefunding rule: still funding, and chain time strictly after the deadline. */
export const fundingDeadlinePassed = (
  status: CampaignStatus,
  fundingDeadline: Date,
  now: Date,
): boolean => status === 'funding' && now > fundingDeadline;

/** Whole days left, rounded up, while funding and not passed; otherwise null. */
export const daysLeft = (
  status: CampaignStatus,
  fundingDeadline: Date,
  now: Date,
): number | null =>
  status !== 'funding' || fundingDeadlinePassed(status, fundingDeadline, now)
    ? null
    : Math.ceil((fundingDeadline.getTime() - now.getTime()) / DAY_MS);

/** FR-037: four buckets by floor(target × bps / 10000); the reserve takes what is left, so the lines sum to the target. */
export const budget = (fundingTarget: string, split: Split) => {
  const target = BigInt(fundingTarget);
  const share = (bps: number): bigint => (target * BigInt(bps)) / BPS_BIG;
  const incentives = share(split.incentivesBps);
  const seedlings = share(split.seedlingsBps);
  const verification = share(split.verificationBps);
  const fee = share(split.feeBps);
  const reserve = target - incentives - seedlings - verification - fee;

  return [
    { bucket: 'incentives', bps: split.incentivesBps, amount: incentives.toString() },
    { bucket: 'seedlings', bps: split.seedlingsBps, amount: seedlings.toString() },
    { bucket: 'verification', bps: split.verificationBps, amount: verification.toString() },
    { bucket: 'reserve', bps: split.reserveBps, amount: reserve.toString() },
    { bucket: 'fee', bps: split.feeBps, amount: fee.toString() },
  ];
};

/** FR-038: the TreeRegistry constant, whatever the commitment. */
export const INCENTIVE_SCHEDULE = MILESTONE_DUE_UNITS.map((month, milestone) => ({
  milestone,
  month,
  bps: MILESTONE_SHARES_BPS[milestone],
}));

/** FR-050: open slots not yet claimed, planted or held by a queued claim; none after the claim deadline. */
export const openAvailable = ({
  openSlots,
  taken,
  queued,
  claimDeadlinePassed,
}: {
  openSlots: number;
  taken: number;
  queued: number;
  claimDeadlinePassed: boolean;
}): number => (claimDeadlinePassed ? 0 : Math.max(0, openSlots - taken - queued));

/** FR-050: a planter's cap less the open slots they hold and their queued claims, floored at 0. */
export const remainingCap = ({
  cap,
  held,
  queued,
}: {
  cap: number;
  held: number;
  queued: number;
}) => Math.max(0, cap - held - queued);

export type CursorPosition = { block: string; address: string };

const cursorSchema = z.strictObject({
  b: z.string().regex(/^(0|[1-9]\d*)$/),
  a: z.string().regex(/^0x[0-9a-f]{40}$/),
});

/** §1 keyset cursor: the last row's (created_block, address). */
export const encodeCampaignCursor = ({ block, address }: CursorPosition): string =>
  encodeCursor({ b: block, a: address });

export const decodeCampaignCursor = (cursor: string): CursorPosition => {
  const { b, a } = decodeCursor(cursor, cursorSchema);

  return { block: b, address: a };
};

export type ClaimRefusal =
  | { code: 'campaign_not_active'; details: { status: string } }
  | { code: 'claim_window_closed'; details: { claimDeadline: string } }
  | { code: 'not_enough_slots'; details: { available: number } }
  | { code: 'planter_cap_exceeded'; details: { remaining: number; cap: number } };

/** §6: the first refusal that applies, in the contract's order: Active, inside the claim window (chain time), enough
 *  open slots, within the planter's cap; null when the claim may be queued. */
export const claimRefusal = ({
  count,
  status,
  claimDeadline,
  chainNow,
  slots,
}: {
  count: number;
  status: string;
  claimDeadline: Date;
  chainNow: Date;
  slots: {
    open: number;
    taken: number;
    queued: number;
    cap: number;
    held: number;
    ownQueued: number;
  };
}): ClaimRefusal | null => {
  if (status !== 'active') {
    return { code: 'campaign_not_active', details: { status } };
  }

  if (chainNow > claimDeadline) {
    return { code: 'claim_window_closed', details: { claimDeadline: claimDeadline.toISOString() } };
  }

  const available = openAvailable({
    openSlots: slots.open,
    taken: slots.taken,
    queued: slots.queued,
    claimDeadlinePassed: false,
  });

  if (count > available) {
    return { code: 'not_enough_slots', details: { available } };
  }

  const remaining = remainingCap({ cap: slots.cap, held: slots.held, queued: slots.ownQueued });

  return count > remaining
    ? { code: 'planter_cap_exceeded', details: { remaining, cap: slots.cap } }
    : null;
};
