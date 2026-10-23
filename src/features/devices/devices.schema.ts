import { createPublicKey } from 'node:crypto';
import { z } from 'zod';

const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

// NFR-002: the server imports the key, so a point off the curve is refused here, not at the first signature
const onCurve = (jwk: { kty: string; crv: string; x: string; y: string }): boolean => {
  try {
    createPublicKey({ key: { ...jwk }, format: 'jwk' });

    return true;
  } catch {
    return false;
  }
};

/** devices §2: exactly a public P-256 JWK (no `d`, NFR-001) and a label; everything else is server-owned. */
export const registerDeviceSchema = z.strictObject({
  publicKeyJwk: z
    .strictObject({
      kty: z.literal('EC'),
      crv: z.literal('P-256'),
      x: z.string().regex(COORDINATE),
      y: z.string().regex(COORDINATE),
    })
    .refine(onCurve, { message: 'Must be a public key on P-256' }),
  label: z.string().trim().min(1).max(64),
});

export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;
