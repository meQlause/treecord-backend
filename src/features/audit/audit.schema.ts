import { z } from 'zod';
import { addressParam, treeIdParam } from '../../shared/http/params.js';

const MAX_SAMPLE = 100;
const MAX_TEXT = 5000;

/** audit §2 (FR-182): the campaign and how many trees to draw; stored as min(requested, population). */
export const openSessionSchema = z.strictObject({
  campaign: addressParam,
  sampleSize: z.number().int().min(1).max(MAX_SAMPLE),
});

export type OpenSessionInput = z.infer<typeof openSessionSchema>;

/** §5 (FR-197): one sampled tree's finding; empty notes after trimming are none. `recordedAt` is server-owned. */
export const findingSchema = z.strictObject({
  treeId: treeIdParam,
  finding: z.enum(['ok', 'issue', 'needs_followup']),
  notes: z
    .string()
    .trim()
    .max(MAX_TEXT)
    .nullable()
    .optional()
    .transform((notes) => (notes === undefined || notes === '' ? null : notes)),
});

export type FindingInput = z.infer<typeof findingSchema>;

/** §7 (FR-190): the private summary, sealed into the notes. */
export const closeSchema = z.strictObject({
  summary: z.string().trim().max(MAX_TEXT).default(''),
});

/** §6 (FR-198): the sampled tree; the code and both instants are server-owned. */
export const challengeSchema = z.strictObject({ treeId: treeIdParam });
