import { describe, expect, it } from 'vitest';
import { fundingShareBps, planterBudget } from '../../../../src/features/donor/donor.rules.js';

// docs/BE/features/donor.md §2 computed fields, with the mockup's figures.
describe('fundingShareBps (FR-073)', () => {
  it.each([
    [
      '1,200 of 18,000 rounds up to 6.67%, where a floor says 6.66%',
      '1200000000',
      '18000000000',
      667,
    ],
    ['250 of 6,840 is 3.65%', '250000000', '6840000000', 365],
    ['900 of 9,000 is 10.00%', '900000000', '9000000000', 1000],
  ])('%s', (_case, contributed, funded, expected) => {
    expect(fundingShareBps(contributed, funded)).toBe(expected);
  });

  it('is null while nothing is raised', () => {
    expect(fundingShareBps('0', '0')).toBeNull();
  });
});

describe('planterBudget (FR-073)', () => {
  it('is the incentive pool once the campaign is active', () => {
    expect(planterBudget('12600000000', '18000000000', 7000)).toBe('12600000000');
  });

  it('is raised × incentivesBps before that', () => {
    expect(planterBudget(null, '6840000000', 7000)).toBe('4788000000');
  });
});
