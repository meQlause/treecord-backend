import { z } from 'zod';

/** accounts §2 request: only changed fields, at least one; server-owned fields are unknown keys and refused. */
export const updateProfileSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(80).optional(),
    isBuyer: z.boolean().optional(),
    role: z.enum(['donor', 'planter']).optional(),
    // acceptance is never withdrawn, so only `true` exists
    carbonRightsAgreementAccepted: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field is required' });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
