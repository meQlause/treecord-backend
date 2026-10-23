import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor.js';

// docs/BE/features/carbon.md: the one availability rule S07, S08 and D08 share, and the list cursors.

export type Availability = 'sold_out' | 'price_not_set' | 'sales_paused' | 'available';

/** FR-216 precedence: no inventory → sold out; then no price; then a price of 0; else available. */
export const availability = (inventory: string, usdcPerTonne: string | null): Availability => {
  if (inventory === '0') {
    return 'sold_out';
  }

  if (usdcPerTonne === null) {
    return 'price_not_set';
  }

  return usdcPerTonne === '0' ? 'sales_paused' : 'available';
};

const UINT = /^(0|[1-9]\d*)$/;

export type BatchPosition = { block: string; batchId: string };

const batchCursorSchema = z.strictObject({ b: z.string().regex(UINT), i: z.string().regex(UINT) });

/** §1: newest issuance first by (issued_block, batch_id); the cursor is the last row's pair. */
export const encodeBatchCursor = ({ block, batchId }: BatchPosition): string =>
  encodeCursor({ b: block, i: batchId });

export const decodeBatchCursor = (cursor: string): BatchPosition => {
  const { b, i } = decodeCursor(cursor, batchCursorSchema);

  return { block: b, batchId: i };
};

const retirementCursorSchema = z.strictObject({ r: z.string().regex(UINT) });

/** §4: newest first by retirement_id (sequential on chain). */
export const encodeRetirementCursor = (retirementId: string): string =>
  encodeCursor({ r: retirementId });

export const decodeRetirementCursor = (cursor: string): string =>
  decodeCursor(cursor, retirementCursorSchema).r;
