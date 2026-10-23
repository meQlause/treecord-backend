import { describe, expect, it } from 'vitest';
import {
  availability,
  decodeBatchCursor,
  decodeRetirementCursor,
  encodeBatchCursor,
  encodeRetirementCursor,
} from '../../../../src/features/carbon/carbon.rules.js';

// docs/BE/features/carbon.md shared values and §1, §4.
describe('availability (FR-216): the first that applies', () => {
  it.each([
    ['no inventory, whatever the price', '0', '17000000', 'sold_out'],
    ['no price set', '8400', null, 'price_not_set'],
    ['a price of 0', '8400', '0', 'sales_paused'],
    ['inventory and a price', '8400', '18500000', 'available'],
  ])('%s', (_case, inventory, price, expected) => {
    expect(availability(inventory, price)).toBe(expected);
  });
});

describe('cursors', () => {
  it("the batch cursor is §1's example for block 481203, batch 101", () => {
    expect(encodeBatchCursor({ block: '481203', batchId: '101' })).toBe(
      'eyJiIjoiNDgxMjAzIiwiaSI6IjEwMSJ9',
    );
    expect(decodeBatchCursor('eyJiIjoiNDgxMjAzIiwiaSI6IjEwMSJ9')).toEqual({
      block: '481203',
      batchId: '101',
    });
  });

  it('the retirement cursor round-trips, and refuses one it did not write', () => {
    expect(decodeRetirementCursor(encodeRetirementCursor('42'))).toBe('42');
    expect(() => decodeRetirementCursor('eyJiIjoiMSJ9')).toThrow(
      expect.objectContaining({ code: 'invalid_cursor' }),
    );
  });
});
