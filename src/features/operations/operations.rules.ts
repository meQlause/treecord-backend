import { BPS, CARBON_UNITS_PER_TONNE } from '../../generated/frozen/constants.js';

// docs/BE/features/operations.md: integer maths only, rounded down (REG-001). 1 carbon unit = 1 kg CO2e.

const MONTHS_PER_YEAR = 12n;
const HALF_MONTHS_PER_YEAR = 24;
const CENTI = 100n;
const TONNE_DECIMALS = 3;
const NO_GROWTH = 0n;

export const ESTIMATE_MODEL = 'linear-maturity-v1';

/** §3: what `linear-maturity-v1` writes into `estimate_method`, besides the species, time, amount and job. */
export const ESTIMATE_FORMULA =
  'treeCount × Σ(month m = 1..M) kgCo2PerYearMature / 12 × min(1, (m − 0.5) / (12 × yearsToMaturity))';

/** "30.00", "30.5" or "30" (numeric(10,2) as Postgres sends it) in hundredths: 3000n, 3050n, 3000n. */
const toCenti = (kilograms: string): bigint => {
  const [whole = '0', fraction = ''] = kilograms.split('.');

  return BigInt(whole) * CENTI + BigInt(fraction.padEnd(2, '0'));
};

/** §3, FR-174: each tree grows linearly to its species' mature rate over `yearsToMaturity`, taken at the middle of
 *  each month. F = Σ over m = 1..M of min(24Y, 2m − 1); the four figures follow from it. */
export const estimateCarbon = ({
  kgCo2PerYearMature,
  yearsToMaturity,
  treeCount,
  commitmentMonths,
}: {
  kgCo2PerYearMature: string;
  yearsToMaturity: number;
  treeCount: number;
  commitmentMonths: number;
}) => {
  const kgCenti = toCenti(kgCo2PerYearMature);
  const full = BigInt(HALF_MONTHS_PER_YEAR * yearsToMaturity);
  // month m adds min(24Y, 2m − 1) half-months of growth
  const factorSum = Array.from({ length: commitmentMonths }, (_month, index) =>
    BigInt(2 * index + 1),
  ).reduce((sum, halfMonths) => sum + (halfMonths < full ? halfMonths : full), NO_GROWTH);

  const denominator = MONTHS_PER_YEAR * full;
  const centiPerTree = (kgCenti * factorSum) / denominator;

  return {
    amount: ((BigInt(treeCount) * kgCenti * factorSum) / (CENTI * denominator)).toString(),
    kgPerTree: `${centiPerTree / CENTI}.${(centiPerTree % CENTI).toString().padStart(2, '0')}`,
    averageMaturityBps: Number((factorSum * BigInt(BPS)) / (BigInt(commitmentMonths) * full)),
  };
};

/** §4, FR-175: tonnes with up to 3 decimals ("12.5", already validated) in carbon units ("12500"). */
export const tonnesToUnits = (tonnes: string): string => {
  const [whole = '0', fraction = ''] = tonnes.split('.');

  return (
    BigInt(whole) * BigInt(CARBON_UNITS_PER_TONNE) +
    BigInt(fraction.padEnd(TONNE_DECIMALS, '0'))
  ).toString();
};

/** §1, FR-174: "Not computed" until the chain confirmed an estimate. The method that produced it is shown only while
 *  its amount is the confirmed one: a newer method describes a run still queued or failed (§3 note). */
export const currentEstimate = (estimatedAmount: string | null, method: unknown) => {
  if (estimatedAmount === null) {
    return null;
  }

  const methodAmount = (method as { amount?: unknown } | null)?.amount;

  return {
    amount: estimatedAmount,
    label: 'pre-certification',
    method: methodAmount === estimatedAmount ? method : null,
  };
};

/** §1, FR-173: unassigned anchors, plus open slots nobody claimed once chain time passes the claim deadline, less
 *  the anchor assignments already queued; never below 0. */
export const availableAnchorSlots = ({
  unassignedAnchors,
  openUnclaimed,
  queued,
  claimDeadlinePassed,
}: {
  unassignedAnchors: number;
  openUnclaimed: number;
  queued: number;
  claimDeadlinePassed: boolean;
}): number => Math.max(0, unassignedAnchors + (claimDeadlinePassed ? openUnclaimed : 0) - queued);
