import { describe, expect, it } from 'vitest';
import { flagEligibility } from '../../../../src/features/flags/flags.rules.js';

const ALEX_WALLET = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';

// docs/BE/features/flags.md §4, FR-059: the first condition that blocks, in order.
describe('flagEligibility', () => {
  it.each([
    {
      name: 'no wallet blocks first',
      wallet: null,
      contributed: '0',
      tree: 'flagged',
      blockedBy: 'wallet_missing',
    },
    {
      name: 'then no contribution',
      wallet: ALEX_WALLET,
      contributed: '0',
      tree: 'flagged',
      blockedBy: 'not_contributor',
    },
    {
      name: 'then a tree past flagging',
      wallet: ALEX_WALLET,
      contributed: '1200000000',
      tree: 'removed',
      blockedBy: 'tree_not_flaggable',
    },
  ])('$name', ({ wallet, contributed, tree, blockedBy }) => {
    expect(flagEligibility({ wallet, contributed, treeStatus: tree })).toEqual({
      eligible: false,
      blockedBy,
    });
  });

  it.each(['alive', 'dead'])('a contributor may flag a %s tree', (tree) => {
    expect(
      flagEligibility({ wallet: ALEX_WALLET, contributed: '1200000000', treeStatus: tree }),
    ).toEqual({ eligible: true, blockedBy: null });
  });
});
