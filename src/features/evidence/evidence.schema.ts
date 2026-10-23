import { z } from 'zod';
import { EVIDENCE_VIDEO_TYPES, MAX_VIDEO_BYTES } from '../../generated/frozen/constants.js';
import { addressParam } from '../../shared/http/params.js';

const positiveId = z.string().regex(/^[1-9]\d{0,18}$/);
// FR-136: the schema only bounds the duration; the duration check judges 4–12 s
const MAX_ANNOUNCED_SECONDS = 600;
const LAST_MILESTONE = 5;

/** evidence §1: PLANTED names a campaign slot, the other kinds a tree; the other field set is refused. */
export const captureTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('PLANTED'), campaign: addressParam, slotId: positiveId }),
  z.strictObject({ kind: z.enum(['ALIVE', 'DEAD', 'REPLANTED']), treeId: positiveId }),
]);

export type CaptureTargetQuery = z.infer<typeof captureTargetSchema>;

const announced = {
  campaign: addressParam,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().min(1).max(MAX_VIDEO_BYTES),
  durationSec: z.number().positive().max(MAX_ANNOUNCED_SECONDS).nullable().default(null),
  contentType: z.enum(EVIDENCE_VIDEO_TYPES).default('video/mp4'),
};

/** evidence §2: the milestone is the index, never the month: ALIVE 1–5, every other kind 0 (FR-103). */
export const uploadUrlSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('PLANTED'),
    slotId: positiveId,
    treeId: z.null().optional(),
    milestone: z.literal(0),
    ...announced,
  }),
  z.strictObject({
    kind: z.literal('ALIVE'),
    treeId: positiveId,
    slotId: z.null().optional(),
    milestone: z.number().int().min(1).max(LAST_MILESTONE),
    ...announced,
  }),
  z.strictObject({
    kind: z.enum(['DEAD', 'REPLANTED']),
    treeId: positiveId,
    slotId: z.null().optional(),
    milestone: z.literal(0),
    ...announced,
  }),
]);

export type UploadUrlBody = z.infer<typeof uploadUrlSchema>;
