import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { enqueue, enqueuedResponse } from '../jobs/index.js';
import {
  toCampaignCard,
  toCampaignPage,
  toViewer,
  type QueuedClaims,
  type Viewer,
} from './campaigns.mapper.js';
import type { CampaignsRepository } from './campaigns.repository.js';
import { claimRefusal, decodeCampaignCursor, encodeCampaignCursor } from './campaigns.rules.js';
import type { ListCampaignsQuery, MetadataInput } from './campaigns.schema.js';

type CampaignsDependencies = {
  repository: CampaignsRepository;
  /** For the claim's transaction: the job and the checks commit or roll back together (ADR-005). */
  database: DatabaseClient;
  /** campaigns §4: the start of every metadataURI (PUBLIC_API_URL). */
  publicApiUrl: string;
  /** jobs §4 for `claim` jobs: queued slot counts on a campaign, in total and for one planter wallet. */
  queuedClaims: (campaign: string, planter: string | null) => Promise<QueuedClaims>;
  /** The latest block's time (ADR-015). */
  chainNow: () => Promise<Date>;
  /** The server clock, only for display when the chain cannot be read. */
  now: () => Date;
};

type Caller = { id: string; wallet_address: string | null };

/** §4: the metadata row and the URI the wallet passes to CampaignFactory.createCampaign. */
const saveMetadata =
  ({ repository, publicApiUrl }: CampaignsDependencies) =>
  async (caller: Caller, input: MetadataInput) => {
    const id = await repository.insertMetadata({
      creator_profile_id: caller.id,
      title: input.title,
      description: input.description,
      species_code: input.speciesCode,
      region_name: input.regionName,
      region_center_lat: input.regionCenter.lat,
      region_center_lon: input.regionCenter.lon,
      region_radius_m: input.regionRadiusM,
      image_urls: input.imageUrls,
    });

    return {
      id,
      metadataURI: new URL(`/api/v1/campaigns/metadata/${id}`, publicApiUrl).toString(),
    };
  };

/** §5: what an on-chain metadataURI resolves to. */
const metadataOf =
  ({ repository }: CampaignsDependencies) =>
  async (id: string) => {
    const row = await repository.metadata(id);

    if (row === undefined) {
      throw new DomainError('not_found');
    }

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      species: { code: row.species_code, name: row.species_name },
      region: {
        name: row.region_name,
        center: { lat: row.region_center_lat, lon: row.region_center_lon },
        radiusM: row.region_radius_m,
      },
      imageUrls: row.image_urls,
      createdAt: row.created_at.toISOString(),
    };
  };

/** §6: a gasless claim queued as a job. The key is checked first (jobs R2), so a retry that already succeeded gets
 *  its job back instead of a refusal; any refusal rolls the insert back. Chain time only: no fallback for an action. */
const claimSlots =
  ({ repository, database, queuedClaims, chainNow }: CampaignsDependencies) =>
  async (caller: Caller, address: string, count: number, idempotencyKey: string | null) => {
    const wallet = caller.wallet_address;

    if (wallet === null) {
      throw new DomainError('wallet_missing');
    }

    const campaign = await repository.byAddress(address);

    if (campaign === undefined) {
      throw new DomainError('not_found');
    }

    // counted before this request's own job exists
    const [figures, queued, now] = await Promise.all([
      repository.walletFigures(address, wallet),
      queuedClaims(address, wallet),
      chainNow(),
    ]);

    return database.transaction().execute(async (trx) => {
      const queuedJob = await enqueue(trx, {
        kind: 'claim',
        payload: { campaign: address, planter: wallet, count },
        createdBy: caller.id,
        idempotencyKey,
      });

      if (queuedJob.outcome === 'replayed') {
        return enqueuedResponse(queuedJob);
      }

      const refusal = claimRefusal({
        count,
        status: campaign.status,
        claimDeadline: campaign.claim_deadline,
        chainNow: now,
        slots: {
          open: campaign.open_slots,
          taken: campaign.open_taken ?? 0,
          queued: queued.total,
          cap: campaign.per_planter_cap,
          held: figures.held ?? 0,
          ownQueued: queued.own,
        },
      });

      if (refusal !== null) {
        throw new DomainError(refusal.code, refusal.details);
      }

      return enqueuedResponse(queuedJob);
    });
  };

/** docs/BE/features/campaigns.md §1–§3: the public catalog, campaign page and species list. */
export const createCampaignsService = (dependencies: CampaignsDependencies) => {
  const { repository, queuedClaims, chainNow, now } = dependencies;
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
    saveMetadata: saveMetadata(dependencies),
    metadata: metadataOf(dependencies),
    claim: claimSlots(dependencies),
  };
};
