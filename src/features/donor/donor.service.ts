import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { decodeCampaignCursor, encodeCampaignCursor } from '../campaigns/index.js';
import { walletCarbonSummary } from '../carbon/index.js';
import { toCard, toDashboard } from './donor.mapper.js';
import { donorRepository, type DonorRepository } from './donor.repository.js';
import type { DonorCampaignsQuery } from './donor.schema.js';

/** The signed-in caller, as far as the donor home needs it. */
type Caller = { id: string; wallet_address: string | null };

// §1: the rail shows the newest 20 with the total beside it; it has no "see all" yet
const RAIL_SIZE = 20;

const walletOf = (caller: Caller): string => {
  if (caller.wallet_address === null) {
    throw new DomainError('wallet_missing');
  }

  return caller.wallet_address;
};

/** docs/BE/features/donor.md: the donor home, over what the caller's wallet contributed to. */
export const createDonorService = ({ database }: { database: DatabaseClient }) => {
  // §1 consistency: every figure from one read-only snapshot
  const inSnapshot = <Result>(
    read: (repository: DonorRepository, trx: DatabaseClient) => Promise<Result>,
  ) =>
    database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((trx) => read(donorRepository(trx), trx));

  return {
    dashboard: (caller: Caller) => {
      const wallet = walletOf(caller);

      return inSnapshot(async (repository, trx) => {
        const [totals, trees, carbon, flags] = await Promise.all([
          repository.totals(wallet),
          repository.treeTotals(wallet),
          walletCarbonSummary(trx, wallet),
          repository.flags(wallet, caller.id, RAIL_SIZE),
        ]);

        return toDashboard({ walletAddress: wallet, totals, trees, carbon, flags });
      });
    },

    campaigns: (caller: Caller, { status, cursor, limit }: DonorCampaignsQuery) => {
      const wallet = walletOf(caller);
      const after = cursor === undefined ? null : decodeCampaignCursor(cursor);

      return inSnapshot(async (repository) => {
        const [rows, total] = await Promise.all([
          repository.page(wallet, status, after, limit + 1),
          repository.count(wallet, status),
        ]);
        const items = rows.slice(0, limit);

        if (items.length === 0) {
          return { items: [], nextCursor: null, total };
        }

        const addresses = items.map((row) => row.address);
        const [money, trees, carbon] = await Promise.all([
          repository.money(wallet, addresses),
          repository.treesByStatus(addresses),
          repository.carbon(wallet, addresses),
        ]);
        const last = items.at(-1);

        return {
          items: items.map((row) => toCard(row, { money, trees, carbon })),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCampaignCursor({ block: last.created_block, address: last.address })
              : null,
          total,
        };
      });
    },
  };
};
