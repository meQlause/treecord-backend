import { z, type ZodType } from 'zod';
import { DomainError } from '../errors.js';

/** A contract address in a path: `0x` + 40 hex in any case, used lowercased (README §4). */
export const addressParam = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((address) => address.toLowerCase());

/** A malformed path parameter answers 400 invalid_path (error-handling §3), never validation_error. */
export const pathParam = <Value>(schema: ZodType<Value>, value: unknown): Value => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new DomainError('invalid_path');
  }

  return parsed.data;
};
