import { describe, expect, it } from 'vitest';
import {
  availableAnchorSlots,
  estimateCarbon,
  tonnesToUnits,
} from '../../../../src/features/operations/operations.rules.js';

const MAHOGANY = { kgCo2PerYearMature: '30.00', yearsToMaturity: 20, commitmentMonths: 36 };

// docs/BE/features/operations.md §3, FR-174.
describe('estimateCarbon', () => {
  it('FR-174 acceptance 1: 8 mahogany trees over 36 months are 54 units, 6.75 kg each, 750 bps of maturity', () => {
    expect(estimateCarbon({ ...MAHOGANY, treeCount: 8 })).toEqual({
      amount: '54',
      kgPerTree: '6.75',
      averageMaturityBps: 750,
    });
  });

  it('the S27 example: 1186 trees are 8005 units (floor of 8005.5)', () => {
    expect(estimateCarbon({ ...MAHOGANY, treeCount: 1186 }).amount).toBe('8005');
  });

  it('a tree past maturity counts the mature rate: one year to maturity, 36 months', () => {
    // F = Σ min(24, 2m − 1): 1 + 3 + … + 23 = 144 for m ≤ 12, then 24 × 24 = 576, so F = 720 of 36 × 24 = 864
    expect(
      estimateCarbon({
        kgCo2PerYearMature: '12',
        yearsToMaturity: 1,
        commitmentMonths: 36,
        treeCount: 1,
      }),
    ).toEqual({ amount: '30', kgPerTree: '30.00', averageMaturityBps: 8333 });
  });

  it('reads one decimal as tenths and keeps the hundredths of kg per tree', () => {
    expect(
      estimateCarbon({ ...MAHOGANY, kgCo2PerYearMature: '30.5', treeCount: 1 }).kgPerTree,
    ).toBe('6.86');
  });
});

// §4, FR-175.
describe('tonnesToUnits', () => {
  it.each([
    ['12.5', '12500'],
    ['1', '1000'],
    ['0.001', '1'],
    ['999999999999999999.999', '999999999999999999999'],
  ])('%s tonnes are %s units', (tonnes, units) => {
    expect(tonnesToUnits(tonnes)).toBe(units);
  });
});

// §1, FR-173.
describe('availableAnchorSlots', () => {
  it.each([
    {
      name: 'before the claim deadline, open slots do not count',
      openUnclaimed: 5,
      passed: false,
      available: 300,
    },
    {
      name: 'after it, unclaimed open slots roll over',
      openUnclaimed: 5,
      passed: true,
      available: 305,
    },
    {
      name: 'queued assignments are taken off',
      anchors: 3,
      queued: 2,
      passed: false,
      available: 1,
    },
    { name: 'never below 0', anchors: 1, queued: 4, passed: true, available: 0 },
  ])('$name', ({ anchors = 300, openUnclaimed = 0, queued = 0, passed, available }) => {
    expect(
      availableAnchorSlots({
        unassignedAnchors: anchors,
        openUnclaimed,
        queued,
        claimDeadlinePassed: passed,
      }),
    ).toBe(available);
  });
});
