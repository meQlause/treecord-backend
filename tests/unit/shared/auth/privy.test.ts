import { describe, expect, it } from 'vitest';
import { privyEmbeddedWallet } from '../../../../src/shared/auth/privy.js';

const EMBEDDED = '0x4B9e2f1A7c3d05e6F8a91b2C3d4e5F6a7B8c9D0e';

// A Privy user with an email, an external wallet and the embedded wallet (GET /api/v1/users/:id).
const user = {
  id: 'did:privy:cm2sari0000000000000000',
  linked_accounts: [
    { type: 'email', address: 'sari@treecord.demo' },
    {
      type: 'wallet',
      wallet_client_type: 'metamask',
      chain_type: 'ethereum',
      address: '0x1111111111111111111111111111111111111111',
    },
    {
      type: 'wallet',
      wallet_client_type: 'privy',
      chain_type: 'solana',
      address: 'So1anaAddress11111111111111111111111111111',
    },
    { type: 'wallet', wallet_client_type: 'privy', chain_type: 'ethereum', address: EMBEDDED },
  ],
};

const lookupWith = (fetchImpl: typeof fetch) =>
  privyEmbeddedWallet({ appId: 'cm2app', appSecret: 'secret', timeoutMs: 1_000, fetchImpl });

describe('privyEmbeddedWallet — accounts §0 steps 4–5', () => {
  it('finds the embedded Ethereum wallet, asking Privy with the app credentials', async () => {
    let asked: { url: string; headers: Record<string, string> } | undefined;
    const lookup = lookupWith(async (url, init) => {
      asked = { url: String(url), headers: init?.headers as Record<string, string> };

      return new Response(JSON.stringify(user), { status: 200 });
    });

    expect(await lookup(user.id)).toBe(EMBEDDED);
    expect(asked?.url).toBe(
      'https://auth.privy.io/api/v1/users/did%3Aprivy%3Acm2sari0000000000000000',
    );
    expect(asked?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('cm2app:secret').toString('base64')}`,
      'privy-app-id': 'cm2app',
    });
  });

  it.each([
    [
      'Privy has no embedded wallet yet',
      async () => new Response(JSON.stringify({ linked_accounts: [] }), { status: 200 }),
    ],
    ['Privy answers an error', async () => new Response('{}', { status: 500 })],
    [
      'Privy is unreachable',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('%s: null, never an error', async (_name, fetchImpl) => {
    expect(await lookupWith(fetchImpl as typeof fetch)(user.id)).toBeNull();
  });
});
