import { z, type ZodType } from 'zod';
import { DomainError } from '../errors.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** README §8: every growing list takes `?cursor=&limit=`, 20 by default and 100 at most (decision 23 Oct 2026). */
export const pageQuery = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
};

/** README §8: a cursor is the last row's sort key as opaque base64url JSON. */
export const encodeCursor = (position: object): string =>
  Buffer.from(JSON.stringify(position)).toString('base64url');

/** Anything that is not a cursor this list wrote answers 400 invalid_cursor. */
export const decodeCursor = <Position>(cursor: string, schema: ZodType<Position>): Position => {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
  } catch {
    throw new DomainError('invalid_cursor');
  }
};
