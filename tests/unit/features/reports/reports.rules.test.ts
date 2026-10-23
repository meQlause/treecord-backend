import { describe, expect, it } from 'vitest';
import {
  decodeEvidenceCursor,
  encodeEvidenceCursor,
  survivalRateBps,
} from '../../../../src/features/reports/reports.rules.js';

// docs/BE/features/reports.md §1 computed values, with the "Roots that stay" figures.
describe('survivalRateBps (FR-065)', () => {
  it('alive, flagged and completed trees over every planted tree', () => {
    expect(
      survivalRateBps({
        planted: 984,
        alive: 948,
        flagged: 2,
        dead: 20,
        removed: 14,
        completed: 0,
      }),
    ).toBe(9654);
  });

  it('is null before anything is planted', () => {
    expect(
      survivalRateBps({ planted: 0, alive: 0, flagged: 0, dead: 0, removed: 0, completed: 0 }),
    ).toBeNull();
  });
});

describe('the evidence cursor (§2)', () => {
  it('is the §2 example for block 24118402, log 3', () => {
    expect(encodeEvidenceCursor({ block: '24118402', logIndex: 3 })).toBe(
      'eyJiIjoiMjQxMTg0MDIiLCJsIjozfQ',
    );
    expect(decodeEvidenceCursor('eyJiIjoiMjQxMTg0MDIiLCJsIjozfQ')).toEqual({
      block: '24118402',
      logIndex: 3,
    });
  });

  it('refuses one it did not write', () => {
    expect(() => decodeEvidenceCursor(encodeEvidenceCursor({ block: 'x', logIndex: 3 }))).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });
});
