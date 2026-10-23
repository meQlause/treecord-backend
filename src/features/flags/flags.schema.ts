import { z } from 'zod';
import { treeIdParam } from '../../shared/http/params.js';

// flags §1, §3: trimmed, then counted in code points, as Postgres char_length counts them
const trimmedText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine(
      (text) => {
        const length = [...text].length;

        return length >= min && length <= max;
      },
      { message: `Must be ${min}–${max} characters` },
    );

/** flags §1 (FR-060): the tree and the reason; the hash, status and flagger are server-owned. */
export const raiseFlagSchema = z.strictObject({
  treeId: treeIdParam,
  reasonText: trimmedText(10, 2000),
});

export type RaiseFlagInput = z.infer<typeof raiseFlagSchema>;

/** flags §3 (FR-171): the operator's decision and note. */
export const resolveFlagSchema = z.strictObject({
  uphold: z.boolean(),
  note: trimmedText(3, 2000),
});

export type ResolveFlagInput = z.infer<typeof resolveFlagSchema>;
