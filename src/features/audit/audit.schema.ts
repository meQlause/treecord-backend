import { z } from 'zod';
import { addressParam } from '../../shared/http/params.js';

const MAX_SAMPLE = 100;

/** audit §2 (FR-182): the campaign and how many trees to draw; stored as min(requested, population). */
export const openSessionSchema = z.strictObject({
  campaign: addressParam,
  sampleSize: z.number().int().min(1).max(MAX_SAMPLE),
});

export type OpenSessionInput = z.infer<typeof openSessionSchema>;
