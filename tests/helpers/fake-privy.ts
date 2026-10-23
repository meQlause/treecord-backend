import { generateKeyPair, SignJWT, type CryptoKey } from 'jose';

// A stand-in for Privy's signing key: tokens are real ES256 JWTs (issuer privy.io, audience the app id) that the
// real @privy-io/node verification accepts, signed with a key pair made for the test run.
export const TEST_APP_ID = 'cm2treecordtest0000000000';

export type FakePrivy = {
  /** Resolves the verification key, as the JWKS endpoint would. */
  resolveKey: () => Promise<CryptoKey>;
  token: (options?: {
    userId?: string;
    appId?: string;
    expiresIn?: string | number;
  }) => Promise<string>;
};

export const fakePrivy = async (): Promise<FakePrivy> => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');

  return {
    resolveKey: async () => publicKey,
    token: ({
      userId = 'did:privy:cm2sari0000000000000000',
      appId = TEST_APP_ID,
      expiresIn = '1h',
    } = {}) =>
      new SignJWT({ sid: 'session-1' })
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
        .setIssuer('privy.io')
        .setAudience(appId)
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(privateKey),
  };
};
