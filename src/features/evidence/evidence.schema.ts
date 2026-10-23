import { z } from 'zod';
import { addressParam } from '../../shared/http/params.js';

const positiveId = z.string().regex(/^[1-9]\d{0,18}$/);

/** evidence §1: PLANTED names a campaign slot, the other kinds a tree; the other field set is refused. */
export const captureTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('PLANTED'), campaign: addressParam, slotId: positiveId }),
  z.strictObject({ kind: z.enum(['ALIVE', 'DEAD', 'REPLANTED']), treeId: positiveId }),
]);

export type CaptureTargetQuery = z.infer<typeof captureTargetSchema>;
