/** Why a caller may not flag a tree, in the order flags §4 checks. */
export type FlagBlock = 'wallet_missing' | 'not_contributor' | 'tree_not_flaggable';

/** flags §4, FR-059: the first condition that blocks, or eligible. */
export const flagEligibility = ({
  wallet,
  contributed,
  treeStatus,
}: {
  wallet: string | null;
  /** Σ contributions.amount of the wallet to the tree's campaign, as a decimal string. */
  contributed: string;
  treeStatus: string;
}): { eligible: boolean; blockedBy: FlagBlock | null } => {
  const blocked = (blockedBy: FlagBlock) => ({ eligible: false, blockedBy });

  if (wallet === null) {
    return blocked('wallet_missing');
  }

  if (contributed === '0') {
    return blocked('not_contributor');
  }

  return treeStatus === 'alive' || treeStatus === 'dead'
    ? { eligible: true, blockedBy: null }
    : blocked('tree_not_flaggable');
};
