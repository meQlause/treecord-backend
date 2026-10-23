import { DomainError } from '../../shared/errors.js';
import { toBatch, toCertificate, toHoldings, toRetirement } from './carbon.mapper.js';
import type { BatchRow, CarbonRepository } from './carbon.repository.js';
import {
  decodeBatchCursor,
  decodeRetirementCursor,
  encodeBatchCursor,
  encodeRetirementCursor,
} from './carbon.rules.js';

/** The signed-in caller, as far as holdings need it. */
type Caller = { role: string; wallet_address: string | null };

export type PageQuery = { cursor?: string; limit: number };

type CarbonDependencies = {
  repository: CarbonRepository;
  chainId: number;
  /** A block's timestamp from the RPC. */
  blockTime: (blockNumber: string) => Promise<Date>;
};

const FIRST_PAGE: PageQuery = { limit: 20 };

const NO_RETIREMENTS = { items: [], nextCursor: null, total: 0 };

const NOTHING_HELD = {
  summary: { issued: '0', allocated: '0', unfilled: '0', retired: '0' },
  reservations: [],
  balances: [],
};

// §1 side effect: the indexer stores no block time, so the first read fills it. An RPC failure serves the batch
// with issuedAt null and the next read tries again; the list never fails for it (ADR-010).
const issuedAtOf =
  ({ repository, blockTime }: CarbonDependencies) =>
  async (row: BatchRow): Promise<Date | null> => {
    if (row.issued_at !== null) {
      return row.issued_at;
    }

    try {
      const issuedAt = await blockTime(row.issued_block);

      await repository.fillIssuedAt(row.batch_id, issuedAt);

      return issuedAt;
    } catch {
      return null;
    }
  };

/** §4: one page of a wallet's retirements, newest first. */
const retirementPage =
  (repository: CarbonRepository) =>
  async (wallet: string, { cursor, limit }: PageQuery) => {
    const after = cursor === undefined ? null : decodeRetirementCursor(cursor);
    const [rows, total] = await Promise.all([
      repository.retirementPage(wallet, after, limit + 1),
      repository.retirementCount(wallet),
    ]);
    const items = rows.slice(0, limit);
    const last = items.at(-1);

    return {
      items: items.map(toRetirement),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeRetirementCursor(last.retirement_id)
          : null,
      total,
    };
  };

/** docs/BE/features/carbon.md §1–§5: the carbon catalogue, a wallet's holdings and the public certificate. */
export const createCarbonService = (dependencies: CarbonDependencies) => {
  const { repository, chainId } = dependencies;
  const issuedAt = issuedAtOf(dependencies);
  const retirementsOf = retirementPage(repository);
  const present = async (row: BatchRow) => toBatch(row, chainId, await issuedAt(row));

  // §3: a wallet is required; a planter's lists are empty by role, whatever the chain holds (FR-212)
  const walletOf = (caller: Caller): string => {
    if (caller.wallet_address === null) {
      throw new DomainError('wallet_missing');
    }

    return caller.wallet_address;
  };

  return {
    batches: async (campaign: string | undefined, { cursor, limit }: PageQuery) => {
      const after = cursor === undefined ? null : decodeBatchCursor(cursor);
      const [rows, total] = await Promise.all([
        repository.batchPage(campaign, after, limit + 1),
        repository.batchCount(campaign),
      ]);
      const items = rows.slice(0, limit);
      const last = items.at(-1);

      return {
        items: await Promise.all(items.map(present)),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeBatchCursor({ block: last.issued_block, batchId: last.batch_id })
            : null,
        total,
      };
    },

    batch: async (batchId: string) => {
      const row = await repository.batch(batchId);

      if (row === undefined) {
        throw new DomainError('not_found');
      }

      return present(row);
    },

    holdings: async (caller: Caller) => {
      const wallet = walletOf(caller);

      if (caller.role === 'planter') {
        return { wallet, ...toHoldings(NOTHING_HELD), retirements: NO_RETIREMENTS };
      }

      const [summary, reservations, balances, retirements] = await Promise.all([
        repository.summary(wallet),
        repository.reservations(wallet),
        repository.balances(wallet),
        retirementsOf(wallet, FIRST_PAGE),
      ]);

      return { wallet, ...toHoldings({ summary, reservations, balances }), retirements };
    },

    retirements: async (caller: Caller, query: PageQuery) => {
      const wallet = walletOf(caller);

      return caller.role === 'planter' ? NO_RETIREMENTS : retirementsOf(wallet, query);
    },

    certificate: async (retirementId: string) => {
      const row = await repository.certificate(retirementId);

      if (row === undefined) {
        throw new DomainError('not_found');
      }

      return toCertificate(row, chainId);
    },
  };
};
