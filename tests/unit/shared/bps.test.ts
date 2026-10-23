import { describe, expect, it } from 'vitest';
import { ratioBps } from '../../../src/shared/bps.js';

// Shared by the report and the donor home (reports.md §1, donor.md §2).
describe('ratioBps', () => {
  it('floors part × 10000 / whole', () => {
    expect(ratioBps('2100000000', '12600000000')).toBe(1666);
    expect(ratioBps('18000000000', '18000000000')).toBe(10_000);
  });

  it('is null without a whole: before activation there is no incentive pool', () => {
    expect(ratioBps('0', null)).toBeNull();
    expect(ratioBps('0', '0')).toBeNull();
  });
});
