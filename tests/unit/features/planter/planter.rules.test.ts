import { describe, expect, it } from 'vitest';
import {
  currentMilestone,
  milestoneAmounts,
  milestoneStates,
  survivalPct,
  tagCode,
} from '../../../../src/features/planter/planter.rules.js';

const epochMs = (iso: string): number => Date.parse(iso);
const TREE_3001 = {
  status: 'alive',
  plantedAt: epochMs('2026-04-18T05:00:00Z'),
  pausedSeconds: '0',
  unitSeconds: '2592000',
};
const PAID_TWICE = { paid: [0, 1], forfeited: [] };
const CHAIN_NOW = epochMs('2026-10-23T09:12:31Z');

// docs/BE/features/planter.md §1 and §5.
describe('tagCode (§5)', () => {
  it('maps bytes onto the 31-character alphabet as TC-XXXX-XXXX', () => {
    expect(tagCode(Uint8Array.from([9, 30, 0, 31, 27, 32, 61, 62]))).toBe('TC-K9AA-6B9A');
  });

  it('skips bytes from 248 up, so no character is favoured', () => {
    expect(tagCode(Uint8Array.from([248, 255, 9, 30, 0, 31, 27, 32, 61, 62]))).toBe('TC-K9AA-6B9A');
  });

  it('is null when fewer than eight bytes were usable', () => {
    expect(tagCode(Uint8Array.from([250, 1, 2, 3, 4, 5, 6, 7]))).toBeNull();
  });

  it('every code it makes matches the column CHECK', () => {
    const bytes = Uint8Array.from({ length: 248 }, (_unused, index) => index);

    for (let start = 0; start < 240; start += 8) {
      expect(tagCode(bytes.slice(start, start + 8))).toMatch(
        /^TC-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
      );
    }
  });
});

describe('milestoneAmounts (§1)', () => {
  it('10.5 USDC per tree: 1.05 ×3, 1.575 ×2 and the remainder', () => {
    expect(
      milestoneAmounts({
        perTreeIncentive: '10500000',
        fundingTarget: '0',
        incentivesBps: 7000,
        treeTarget: 1,
      }),
    ).toEqual(['1050000', '1050000', '1050000', '1575000', '1575000', '4200000']);
  });

  it('before activation: target × incentives / trees, so 10,000 USDC over 1,000 trees is 7 per tree', () => {
    expect(
      milestoneAmounts({
        perTreeIncentive: null,
        fundingTarget: '10000000000',
        incentivesBps: 7000,
        treeTarget: 1000,
      }),
    ).toEqual(['700000', '700000', '700000', '1050000', '1050000', '2800000']);
  });
});

describe('milestoneStates (§1, FR-082)', () => {
  it('tree 3001 at chain time 2026-10-23: two paid, month 6 open, the rest upcoming', () => {
    expect(milestoneStates(TREE_3001, PAID_TWICE, CHAIN_NOW).map(({ state }) => state)).toEqual([
      'paid',
      'paid',
      'open',
      'upcoming',
      'upcoming',
      'upcoming',
    ]);
  });

  it('the close of the window is still open; a moment later it is missed', () => {
    const closes = epochMs('2026-11-14T05:00:00Z');

    expect(milestoneStates(TREE_3001, PAID_TWICE, closes)[2]?.state).toBe('open');
    expect(milestoneStates(TREE_3001, PAID_TWICE, closes + 1000)[2]?.state).toBe('missed');
  });

  it('a flagged tree pauses what is unpaid; a removed one forfeits it', () => {
    const flagged = { ...TREE_3001, status: 'flagged' };
    const removed = { ...TREE_3001, status: 'removed' };

    expect(milestoneStates(flagged, PAID_TWICE, CHAIN_NOW)[2]?.state).toBe('paused');
    expect(milestoneStates(removed, PAID_TWICE, CHAIN_NOW)[2]?.state).toBe('forfeited');
  });
});

describe('currentMilestone and survivalPct (§1)', () => {
  it('the lowest unsettled milestone, null once all six are settled', () => {
    expect(currentMilestone(PAID_TWICE)).toBe(2);
    expect(currentMilestone({ paid: [0, 1, 2, 3, 4], forfeited: [5] })).toBeNull();
  });

  it('5 of 8 standing is 62.5%; none planted is null', () => {
    expect(survivalPct(5, 8)).toBe(62.5);
    expect(survivalPct(2, 3)).toBeCloseTo(66.7, 10);
    expect(survivalPct(0, 0)).toBeNull();
  });
});
