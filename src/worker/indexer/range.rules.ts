export type IndexRange = { fromBlock: bigint; toBlock: bigint };

export type RangeOptions = {
  cursor: bigint | null;
  startBlock: bigint;
  head: bigint;
  confirmations: number;
  chunkBlocks: number;
  rescanBlocks: number;
};

const ONE = BigInt(1);

const larger = (left: bigint, right: bigint): bigint => (left > right ? left : right);
const smaller = (left: bigint, right: bigint): bigint => (left < right ? left : right);

/**
 * The block range for the next cycle: from just after the cursor (minus the re-scan margin, never before the start
 * block) up to one chunk of new blocks, capped at the confirmed head. Null when nothing is confirmed yet.
 */
export const nextRange = (options: RangeOptions): IndexRange | null => {
  const safeHead = options.head - BigInt(options.confirmations);
  const firstNew = options.cursor === null ? options.startBlock : options.cursor + ONE;
  const fromBlock = larger(firstNew - BigInt(options.rescanBlocks), options.startBlock);
  const toBlock = smaller(firstNew + BigInt(options.chunkBlocks) - ONE, safeHead);

  return toBlock < fromBlock ? null : { fromBlock, toBlock };
};
