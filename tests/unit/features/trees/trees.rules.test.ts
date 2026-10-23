import { describe, expect, it } from 'vitest';
import {
  currentMilestone,
  geohashCentre,
  milestoneAmounts,
  milestoneStatus,
  milestoneWindows,
  sumAmounts,
} from '../../../../src/features/trees/trees.rules.js';

const epochMs = (iso: string): number => Date.parse(iso);
const PLANTED_AT = epochMs('2026-04-18T05:00:00Z');
const UNIT = '2592000';
const CHAIN_NOW = epochMs('2026-10-23T03:12:44Z');

// docs/BE/features/trees.md §1 computed values, with their worked examples.
describe('geohashCentre', () => {
  it('cell qqtttzp has its centre at -7.431564, 109.24736 (FR-053)', () => {
    expect(geohashCentre('qqtttzp')).toEqual({ lat: -7.431564, lon: 109.24736 });
  });
});

describe('milestoneWindows', () => {
  it('opens at planting + month × unit + paused time, and closes one unit later (FR-055)', () => {
    const windows = milestoneWindows(PLANTED_AT, UNIT, '0');

    expect(windows.map(({ month }) => month)).toEqual([0, 3, 6, 12, 24, 36]);
    expect(windows[1]).toEqual({
      milestone: 1,
      month: 3,
      opensAt: epochMs('2026-07-17T05:00:00Z'),
      closesAt: epochMs('2026-08-16T05:00:00Z'),
    });
    expect(windows[5]?.opensAt).toBe(epochMs('2029-04-02T05:00:00Z'));
  });

  it('a dismissed flag shifts every window by the paused seconds', () => {
    expect(milestoneWindows(PLANTED_AT, UNIT, '86400')[1]?.opensAt).toBe(
      epochMs('2026-07-18T05:00:00Z'),
    );
  });
});

describe('milestoneAmounts', () => {
  it('10.5 USDC per tree: 1.05 ×3, 1.575 ×2, and the remainder 4.2 (FR-055)', () => {
    expect(milestoneAmounts('10500000')).toEqual([
      '1050000',
      '1050000',
      '1050000',
      '1575000',
      '1575000',
      '4200000',
    ]);
  });

  it('7 USDC per tree (10,000 USDC over 1,000 trees): 0.7 and 2.8', () => {
    expect(milestoneAmounts('7000000')).toEqual([
      '700000',
      '700000',
      '700000',
      '1050000',
      '1050000',
      '2800000',
    ]);
  });

  it('before activation every amount is null', () => {
    expect(milestoneAmounts(null)).toEqual([null, null, null, null, null, null]);
  });
});

describe('milestoneStatus (FR-056): the first rule that applies', () => {
  const window = {
    opensAt: epochMs('2026-10-15T05:00:00Z'),
    closesAt: epochMs('2026-11-14T05:00:00Z'),
  };
  const settled = { paid: false, forfeited: false };

  it.each([
    {
      name: 'paid',
      record: { ...settled, paid: true },
      tree: 'flagged',
      now: CHAIN_NOW,
      is: 'paid',
    },
    {
      name: 'forfeited',
      record: { ...settled, forfeited: true },
      tree: 'alive',
      now: CHAIN_NOW,
      is: 'forfeited',
    },
    {
      name: 'a removed tree forfeits',
      record: settled,
      tree: 'removed',
      now: CHAIN_NOW,
      is: 'forfeited',
    },
    {
      name: 'a flagged tree pauses',
      record: settled,
      tree: 'flagged',
      now: CHAIN_NOW,
      is: 'paused',
    },
    {
      name: 'before the window',
      record: settled,
      tree: 'alive',
      now: epochMs('2026-10-15T04:59:59Z'),
      is: 'upcoming',
    },
    { name: 'inside the window', record: settled, tree: 'alive', now: CHAIN_NOW, is: 'open' },
    {
      name: 'at the close, which is excluded',
      record: settled,
      tree: 'alive',
      now: window.closesAt,
      is: 'missed',
    },
  ])('$name', ({ record, tree, now, is }) => {
    expect(milestoneStatus({ ...window, ...record, treeStatus: tree, now })).toBe(is);
  });
});

describe('currentMilestone (FR-057)', () => {
  it('the lowest milestone neither paid nor forfeited', () => {
    expect(currentMilestone([0, 1], [])).toBe(2);
    expect(currentMilestone([0], [1])).toBe(2);
  });

  it('5 once all six are settled', () => {
    expect(currentMilestone([0, 1, 2, 3, 4], [5])).toBe(5);
  });
});

describe('sumAmounts (FR-057)', () => {
  it('adds decimal strings as bigint, keeping digits past 2^53 (REG-001)', () => {
    expect(sumAmounts(['1050000', '1050000'])).toBe('2100000');
    expect(sumAmounts(['9007199254740993', '1'])).toBe('9007199254740994');
    expect(sumAmounts([])).toBe('0');
  });
});
