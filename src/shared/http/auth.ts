import type { RequestHandler } from 'express';
import type { TokenVerifier } from '../auth/privy.js';
import { DomainError } from '../errors.js';

export type AuthOptions = {
  verify: TokenVerifier;
  /** ADR-007: wallet-signature tokens for the demo scripts, off unless DEMO_WALLET_AUTH=true. */
  demoWalletAuth: boolean;
  /** accounts §0: the lowercase signer of a valid demo token; throws for any other token. */
  verifyWallet: (token: string) => Promise<string>;
  /** accounts §0 steps 3–6: the caller's profile, created on the first sign-in. */
  resolveProfile: (privyUserId: string) => Promise<unknown>;
};

const BEARER = /^Bearer (\S+)$/;
const DEMO_TOKEN_PREFIX = 'wallet.';
const DEMO_USER_PREFIX = 'wallet:';

/** be-architecture §5 row 7: every private route runs behind this (accounts §0 steps 1–2). */
/** accounts §0 step 2: the user id a token proves. A demo wallet token is `wallet:<address>`, accepted only when the
 *  server runs with DEMO_WALLET_AUTH=true; otherwise, and when it does not verify, 401 invalid_token. */
const userIdOf = async (
  token: string,
  { verify, demoWalletAuth, verifyWallet }: AuthOptions,
): Promise<string> => {
  if (!token.startsWith(DEMO_TOKEN_PREFIX)) {
    return (await verify(token)).privyUserId;
  }

  if (!demoWalletAuth) {
    throw new DomainError('invalid_token');
  }

  const wallet = await verifyWallet(token).catch(() => {
    throw new DomainError('invalid_token');
  });

  return `${DEMO_USER_PREFIX}${wallet}`;
};

export const authenticate =
  (options: AuthOptions): RequestHandler =>
  async (req, res, next) => {
    const token = BEARER.exec(req.get('authorization') ?? '')?.[1];

    if (token === undefined) {
      throw new DomainError('missing_token');
    }

    res.locals['profile'] = await options.resolveProfile(await userIdOf(token, options));
    next();
  };

/** A public route that adds the caller's own figures when a token is sent (campaigns §2): no Authorization header
 *  passes through without a profile; a header that fails is 401 as on a private route. */
export const authenticateIfPresent = (options: AuthOptions): RequestHandler => {
  const required = authenticate(options);

  return async (req, res, next) => {
    if (req.get('authorization') === undefined) {
      next();

      return;
    }

    await required(req, res, next);
  };
};
