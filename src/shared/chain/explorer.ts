// carbon.md shared values: a transaction link where a public explorer exists, none on a local chain.
const EXPLORER_TX: Readonly<Record<number, string>> = {
  84532: 'https://sepolia.basescan.org/tx/',
};

export const txUrl = (chainId: number, hash: string): string | null => {
  const base = EXPLORER_TX[chainId];

  return base === undefined ? null : `${base}${hash}`;
};
