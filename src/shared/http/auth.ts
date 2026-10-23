import type { RequestHandler } from 'express';
import type { TokenVerifier } from '../auth/privy.js';
import { DomainError } from '../errors.js';

export type AuthOptions = {
  verify: TokenVerifier;
  /** ADR-007: wallet-signature tokens for the demo scripts, off unless DEMO_WALLET_AUTH=true. */
  demoWalletAuth: boolean;
};

const BEARER = /^Bearer (\S+)$/;
const DEMO_TOKEN_PREFIX = 'wallet.';

/** be-architecture §5 row 7: every private route runs behind this (accounts §0 steps 1–2). */
export const authenticate =
  ({ verify }: AuthOptions): RequestHandler =>
  async (req, res, next) => {
    const token = BEARER.exec(req.get('authorization') ?? '')?.[1];

    if (token === undefined) {
      throw new DomainError('missing_token');
    }

    // ponytail: the DEMO_WALLET_AUTH=true path (accounts §0) is not built yet — a demo token is refused either way
    // until phases.md B8 adds it for the demo scripts.
    if (token.startsWith(DEMO_TOKEN_PREFIX)) {
      throw new DomainError('invalid_token');
    }

    res.locals['privyUserId'] = (await verify(token)).privyUserId;
    next();
  };
