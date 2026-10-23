import {
  BPS,
  MILESTONE_COUNT,
  MILESTONE_DUE_UNITS,
  MILESTONE_SHARES_BPS,
} from '../../generated/frozen/constants.js';

// docs/BE/features/trees.md §1 computed values: the tree page's maths, pure so every branch is unit-tested.

const MS_PER_SECOND = 1000;
const BPS_BIG = BigInt(BPS);
const LAST_MILESTONE = MILESTONE_COUNT - 1;
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';
const BITS_PER_CHAR = 5;
const DECIMALS = 6;
const LAT_RANGE = 90;
const LON_RANGE = 180;

/** FR-053: the centre of a geohash cell, 6 decimals; what everyone but the planter, operators and auditors sees. */
export const geohashCentre = (geohash: string): { lat: number; lon: number } => {
  const lat = { low: -LAT_RANGE, high: LAT_RANGE };
  const lon = { low: -LON_RANGE, high: LON_RANGE };
  let even = true;

  for (const char of geohash) {
    const value = GEOHASH_ALPHABET.indexOf(char);

    for (let bit = BITS_PER_CHAR - 1; bit >= 0; bit -= 1) {
      // bits alternate longitude, latitude; each halves the range it belongs to
      const range = even ? lon : lat;
      const middle = (range.low + range.high) / 2;
      const side = (value >> bit) & 1 ? 'low' : 'high';

      range[side] = middle;
      even = !even;
    }
  }

  const centre = (range: { low: number; high: number }): number =>
    Number(((range.low + range.high) / 2).toFixed(DECIMALS));

  return { lat: centre(lat), lon: centre(lon) };
};

/** FR-055: each window opens at planting + month × unit + paused time and closes one unit later, half-open.
 *  Instants are epoch milliseconds. */
export const milestoneWindows = (
  plantedAtMs: number,
  timeUnitSeconds: string,
  pausedSeconds: string,
) =>
  MILESTONE_DUE_UNITS.map((month, milestone) => {
    const opensAt =
      plantedAtMs + (month * Number(timeUnitSeconds) + Number(pausedSeconds)) * MS_PER_SECOND;

    return {
      milestone,
      month,
      opensAt,
      closesAt: opensAt + Number(timeUnitSeconds) * MS_PER_SECOND,
    };
  });

/** FR-055: floor(perTree × bps / 10000) for milestones 0–4; the last pays the remainder. Null before activation. */
export const milestoneAmounts = (perTreeIncentive: string | null): (string | null)[] => {
  if (perTreeIncentive === null) {
    return MILESTONE_SHARES_BPS.map(() => null);
  }

  const perTree = BigInt(perTreeIncentive);
  const shares = MILESTONE_SHARES_BPS.slice(0, LAST_MILESTONE).map(
    (bps) => (perTree * BigInt(bps)) / BPS_BIG,
  );
  const remainder = shares.reduce((left, share) => left - share, perTree);

  return [...shares, remainder].map(String);
};

export type MilestoneStatus = 'paid' | 'forfeited' | 'paused' | 'upcoming' | 'open' | 'missed';

/** FR-056: the first rule that applies. `now` is chain time, never the server clock (REG-009); all epoch ms. */
export const milestoneStatus = ({
  paid,
  forfeited,
  treeStatus,
  opensAt,
  closesAt,
  now,
}: {
  paid: boolean;
  forfeited: boolean;
  treeStatus: string;
  opensAt: number;
  closesAt: number;
  now: number;
}): MilestoneStatus => {
  if (paid) {
    return 'paid';
  }

  if (forfeited || treeStatus === 'removed') {
    return 'forfeited';
  }

  if (treeStatus === 'flagged') {
    return 'paused';
  }

  if (now < opensAt) {
    return 'upcoming';
  }

  // both ends count: the contract rejects a check-in only before opensAt or after closesAt (trees.md §1, FR-137)
  return now <= closesAt ? 'open' : 'missed';
};

/** FR-057: Σ of decimal-string amounts, as bigint (REG-001). */
export const sumAmounts = (amounts: string[]): string =>
  amounts.reduce((sum, amount) => sum + BigInt(amount), BigInt(0)).toString();

/** FR-057: the lowest milestone with neither a payout nor a forfeit; the last once all six are settled. */
export const currentMilestone = (paid: number[], forfeited: number[]): number => {
  const unsettled = MILESTONE_DUE_UNITS.findIndex(
    (_month, milestone) => !paid.includes(milestone) && !forfeited.includes(milestone),
  );

  return unsettled === -1 ? LAST_MILESTONE : unsettled;
};
