import { describe, expect, it } from 'vitest';
import { txUrl } from '../../../../src/shared/chain/explorer.js';

const HASH = '0x1b8e3f5a7c9d0e2b4f6a8c1d3e5b7f9a0c2d4e6b8f1a3c5e7d9b0f2a4c6e8d1b';

// docs/BE/features/carbon.md shared values: the configured explorer's link, none on a local chain.
describe('txUrl', () => {
  it('links Base Sepolia transactions to basescan, as carbon.md §1 shows', () => {
    expect(txUrl(84532, HASH)).toBe(`https://sepolia.basescan.org/tx/${HASH}`);
  });

  it('has no link on the local chain', () => {
    expect(txUrl(31337, HASH)).toBeNull();
  });
});
