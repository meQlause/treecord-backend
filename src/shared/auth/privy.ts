import { verifyAccessToken } from '@privy-io/node';
import { createRemoteJWKSet, decodeProtectedHeader, errors, type CryptoKey } from 'jose';
import { DomainError } from '../errors.js';

/** Verifies a bearer token; throws invalid_token or service_unavailable (accounts §0 step 2, ADR-007, ADR-010). */
export type TokenVerifier = (token: string) => Promise<{ privyUserId: string }>;

/** The ES256 key Privy signed this token with. */
export type KeyResolver = (token: string) => Promise<CryptoKey>;

// The SDK reports every failure, a key server outage included, as an invalid token. So the key is resolved here
// first: a token jose cannot match to a key is invalid, anything else (network, timeout, bad JWKS) is Privy
// unavailable — never a pass, never a sign-out.
const UNAVAILABLE = [errors.JWKSTimeout, errors.JWKSInvalid];

const isInvalidToken = (error: unknown): boolean =>
  error instanceof errors.JOSEError && !UNAVAILABLE.some((type) => error instanceof type);

export const privyVerifier =
  ({ appId, resolveKey }: { appId: string; resolveKey: KeyResolver }): TokenVerifier =>
  async (token) => {
    const key = await resolveKey(token).catch((error: unknown) => {
      throw new DomainError(isInvalidToken(error) ? 'invalid_token' : 'service_unavailable');
    });

    try {
      const verified = await verifyAccessToken({
        access_token: token,
        app_id: appId,
        verification_key: key,
      });

      return { privyUserId: verified.user_id };
    } catch {
      throw new DomainError('invalid_token');
    }
  };

/** Privy's published keys for the app; jose caches them and refetches only for an unknown key id. */
export const privyJwks = (appId: string): KeyResolver => {
  const jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));

  return (token) => jwks(decodeProtectedHeader(token));
};

type PrivyUser = {
  linked_accounts?: Array<{
    type?: string;
    wallet_client_type?: string;
    chain_type?: string;
    address?: string;
  }>;
};

/**
 * The user's Privy embedded Ethereum wallet (accounts §0 steps 4–5), or null when Privy has none yet or the lookup
 * fails or times out: not an error, the next request asks again (ADR-010, FR-003 #4).
 */
export const privyEmbeddedWallet =
  ({
    appId,
    appSecret,
    timeoutMs,
    fetchImpl = fetch,
  }: {
    appId: string;
    appSecret: string;
    timeoutMs: number;
    fetchImpl?: typeof fetch;
  }) =>
  async (privyUserId: string): Promise<string | null> => {
    const credentials = Buffer.from(`${appId}:${appSecret}`).toString('base64');

    try {
      const response = await fetchImpl(
        `https://auth.privy.io/api/v1/users/${encodeURIComponent(privyUserId)}`,
        {
          headers: {
            authorization: `Basic ${credentials}`,
            'privy-app-id': appId,
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );

      if (!response.ok) {
        return null;
      }

      const user = (await response.json()) as PrivyUser;
      const wallet = user.linked_accounts?.find(
        (account) =>
          account.type === 'wallet' &&
          account.wallet_client_type === 'privy' &&
          account.chain_type === 'ethereum',
      );

      return wallet?.address ?? null;
    } catch {
      return null;
    }
  };
