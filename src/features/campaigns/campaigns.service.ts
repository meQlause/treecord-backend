import { DomainError } from '../../shared/errors.js';
import {
  toCampaignCard,
  toCampaignPage,
  toViewer,
  type QueuedClaims,
  type Viewer,
} from './campaigns.mapper.js';
import type { CampaignsRepository } from './campaigns.repository.js';
import { decodeCampaignCursor, encodeCampaignCursor } from './campaigns.rules.js';
import type { ListCampaignsQuery } from './campaigns.schema.js';

type CampaignsDependencies = {
  repository: CampaignsRepository;
  /** jobs §4 for `claim` jobs: queued slot counts on a campaign, in total and for one planter wallet. */
  queuedClaims: (campaign: string, planter: string | null) => Promise<QueuedClaims>;
  /** The latest block's time (ADR-015). */
  chainNow: () => Promise<Date>;
  /** The server clock, only for display when the chain cannot be read. */
  now: () => Date;
};

/** docs/BE/features/campaigns.md §1–§3: the public catalog, campaign page and species list. */
export const createCampaignsService = ({
  repository,
  queuedClaims,
  chainNow,
  now,
}: CampaignsDependencies) => {
  // campaigns shared rules, ADR-010: these pages only display deadlines, so they fall back to the server clock and
  // still render when the RPC is down. Actions never use this.
  const displayNow = (): Promise<Date> => chainNow().catch(() => now());

  return {
    list: async ({ cursor, limit, ...filters }: ListCampaignsQuery) => {
      const after = cursor === undefined ? null : decodeCampaignCursor(cursor);
      const [rows, total, shownAt] = await Promise.all([
        repository.page(filters, after, limit + 1),
        repository.count(filters),
        displayNow(),
      ]);
      const items = rows.slice(0, limit);
      const last = items.at(-1);

      return {
        items: items.map((row) => toCampaignCard(row, shownAt)),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCampaignCursor({ block: last.created_block, address: last.address })
            : null,
        total,
      };
    },

    page: async (address: string, viewer: Viewer | undefined) => {
      const wallet = viewer?.wallet_address ?? null;
      const [row, shownAt, queued, figures] = await Promise.all([
        repository.byAddress(address),
        displayNow(),
        queuedClaims(address, wallet),
        wallet === null ? null : repository.walletFigures(address, wallet),
      ]);

      if (row === undefined) {
        throw new DomainError('not_found');
      }

      return {
        campaign: toCampaignPage(row, shownAt, queued),
        viewer: viewer === undefined ? null : toViewer(row, viewer, figures, queued),
      };
    },

    species: async () => {
      const rows = await repository.species();

      return {
        items: rows.map((row) => ({ code: row.code, name: row.english_name })),
        nextCursor: null,
        total: rows.length,
      };
    },
  };
};
