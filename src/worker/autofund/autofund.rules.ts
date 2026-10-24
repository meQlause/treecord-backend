// Testnet auto-funding: which calls fill a campaign from the operator wallet, given what the chain says now.
// Each step is decided from fresh chain state, so a pass that stopped half way picks up where it left off.

export type FundingState = {
  /** fundingTarget − totalRaised, in USDC base units. */
  remaining: bigint;
  /** The operator's USDC balance. */
  balance: bigint;
  /** What the operator has allowed the campaign to take. */
  allowance: bigint;
};

export type FundingStep =
  | { kind: 'mint'; amount: bigint }
  | { kind: 'approve'; amount: bigint }
  | { kind: 'contribute'; amount: bigint };

const ZERO = BigInt(0);

/** The calls, in order, that bring `remaining` to zero; none when the campaign is already full. */
export const fundingSteps = ({ remaining, balance, allowance }: FundingState): FundingStep[] => {
  if (remaining <= ZERO) {
    return [];
  }

  return [
    ...(balance < remaining ? [{ kind: 'mint', amount: remaining - balance } as const] : []),
    ...(allowance < remaining ? [{ kind: 'approve', amount: remaining } as const] : []),
    { kind: 'contribute', amount: remaining },
  ];
};
