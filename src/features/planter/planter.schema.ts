import { z } from 'zod';
import { pageQuery } from '../../shared/http/cursor.js';

/** planter §1. */
export const treesQuerySchema = z.strictObject({
  status: z.enum(['alive', 'flagged', 'dead', 'removed', 'completed']).optional(),
  ...pageQuery,
});

/** planter §3. */
export const pageQuerySchema = z.strictObject(pageQuery);

/** planter §4: `sent` is every server status except `rejected`. */
export const uploadsQuerySchema = z.strictObject({
  filter: z.enum(['all', 'sent', 'rejected']).default('all'),
  ...pageQuery,
});

export type TreesQuery = z.infer<typeof treesQuerySchema>;

export type PageQuery = z.infer<typeof pageQuerySchema>;

export type UploadsQuery = z.infer<typeof uploadsQuerySchema>;
