import { z, type ZodType } from 'zod';
import { DomainError } from '../errors.js';

/** A contract address in a path: `0x` + 40 hex in any case, used lowercased (README §4). */
export const addressParam = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((address) => address.toLowerCase());

const MAX_TREE_ID = 9_223_372_036_854_775_807n;

/** A tree id: a positive decimal within bigint range, kept a string (REG-001). One check, so BigInt never sees a string
 *  the pattern refused (zod runs every check, even after one fails). */
export const treeIdParam = z
  .string()
  .refine((treeId) => /^[1-9]\d{0,18}$/.test(treeId) && BigInt(treeId) <= MAX_TREE_ID);

/** A malformed path parameter answers 400 invalid_path (error-handling §3), never validation_error. */
export const pathParam = <Value>(schema: ZodType<Value>, value: unknown): Value => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new DomainError('invalid_path');
  }

  return parsed.data;
};
