// CampaignFactory and Campaign events into `campaigns`, `contributions`, `refunds`, `slots` and the milestone tables.
import { bytes8ToGeohash, decodeGeohash, type LatLon } from '../../generated/frozen/evidence.js';
import {
  insert,
  isoFromSeconds,
  maybeOne,
  once,
  one,
  updateWhere,
  type Queryable,
  type Row,
} from '../worker-db.repository.js';
import {
  anchorSlotCount,
  eventRow,
  metadataIdFromUri,
  slotKind,
  speciesCodeFromBytes32,
  u256,
} from './apply.rules.js';
import type { ApplyContext } from './apply.service.js';
import { lower, type EventMeta, type IndexedEvent } from './decode.rules.js';

type FactoryEvent = Extract<IndexedEvent, { source: 'factory' }>['event'];
type CampaignCreatedArgs = Extract<FactoryEvent, { eventName: 'CampaignCreated' }>['args'];
type CampaignEvent = Extract<IndexedEvent, { source: 'campaign' }>['event'];
type Handler<Name extends CampaignEvent['eventName']> = (
  context: ApplyContext,
  meta: EventMeta,
  event: Extract<CampaignEvent, { eventName: Name }>,
) => Promise<void>;

type MetadataRow = {
  id: string;
  title: string;
  description: string | null;
  region_name: string | null;
  region_center_lat: number;
  region_center_lon: number;
};

const loadMetadata = (
  database: Queryable,
  metadataId: string | null,
): Promise<MetadataRow | null> =>
  metadataId
    ? maybeOne<MetadataRow>(
        database,
        'load campaign metadata',
        `select id, title, description, region_name, region_center_lat, region_center_lon
         from public.campaign_metadata where id = $1`,
        [metadataId],
      )
    : Promise.resolve(null);

const geohashOf = (bytes: Parameters<typeof bytes8ToGeohash>[0]): string => {
  try {
    return bytes8ToGeohash(bytes);
  } catch {
    return '';
  }
};

/** The region center comes from the uploaded metadata, or from the on-chain geohash cell. */
const centerOf = (metadata: MetadataRow | null, geohash: string): LatLon | null => {
  if (metadata) {
    return { lat: metadata.region_center_lat, lon: metadata.region_center_lon };
  }

  return geohash ? decodeGeohash(geohash) : null;
};

const metadataColumns = (metadata: MetadataRow | null): Row =>
  metadata
    ? {
        metadata_id: metadata.id,
        title: metadata.title,
        description: metadata.description,
        region_name: metadata.region_name,
      }
    : { metadata_id: null, title: null, description: null, region_name: null };

const campaignRow = (
  args: CampaignCreatedArgs,
  found: {
    metadata: MetadataRow | null;
    speciesName: string | null;
    creatorProfileId: string | null;
  },
  chainId: number,
  meta: EventMeta,
): Row => {
  const config = args.config;
  const geohash = geohashOf(config.regionGeohash);
  const center = centerOf(found.metadata, geohash);
  const treeTarget = Number(config.treeTarget);
  const anchorSlots = anchorSlotCount(treeTarget, config.anchorBps);
  const speciesCode = speciesCodeFromBytes32(config.speciesCode);

  return {
    address: lower(args.campaign),
    chain_id: chainId,
    creator_address: lower(args.creator),
    creator_profile_id: found.creatorProfileId,
    ...metadataColumns(found.metadata),
    species_code: speciesCode || null,
    species_name: found.speciesName,
    region_center_lat: center ? center.lat : null,
    region_center_lon: center ? center.lon : null,
    region_radius_m: Number(config.regionRadiusM),
    region_geohash: geohash,
    tree_target: treeTarget,
    anchor_slots: anchorSlots,
    open_slots: treeTarget - anchorSlots,
    per_planter_cap: config.perPlanterCap,
    funding_target: u256(config.fundingTarget),
    funding_deadline: isoFromSeconds(config.fundingDeadline),
    claim_deadline: isoFromSeconds(config.claimDeadline),
    commitment_units: config.commitmentUnits,
    time_unit_seconds: Number(config.timeUnit),
    split: {
      incentivesBps: config.split.incentivesBps,
      seedlingsBps: config.split.seedlingsBps,
      verificationBps: config.split.verificationBps,
      reserveBps: config.split.reserveBps,
      feeBps: config.split.feeBps,
    },
    metadata_uri: config.metadataURI,
    created_block: Number(meta.blockNumber),
    created_tx: meta.txHash,
  };
};

export const onCampaignCreated = async (
  context: ApplyContext,
  meta: EventMeta,
  args: CampaignCreatedArgs,
): Promise<void> => {
  const { db } = context;
  // one after another: they run on the chunk transaction's single connection
  const metadata = await loadMetadata(db, metadataIdFromUri(args.config.metadataURI));
  const species = await maybeOne<{ scientific_name: string }>(
    db,
    'load species',
    'select scientific_name from public.species where code = $1',
    [speciesCodeFromBytes32(args.config.speciesCode)],
  );
  const profile = await maybeOne<{ id: string }>(
    db,
    'load creator profile',
    'select id from public.profiles where wallet_address = $1',
    [lower(args.creator)],
  );
  const row = campaignRow(
    args,
    {
      metadata,
      speciesName: species?.scientific_name ?? null,
      creatorProfileId: profile?.id ?? null,
    },
    context.chainId,
    meta,
  );

  await insert(db, 'upsert campaign', { table: 'campaigns', conflict: ['address'] }, row);
  context.log.info(
    { campaign: row['address'], block: Number(meta.blockNumber) },
    'campaign indexed',
  );
};

const updateCampaign = (context: ApplyContext, meta: EventMeta, changes: Row, label: string) =>
  updateWhere(
    context.db,
    label,
    { table: 'campaigns', where: 'address = $1', values: [meta.address] },
    changes,
  );

const onContributed: Handler<'Contributed'> = async (context, meta, event) => {
  const { contributor, amount, totalRaised } = event.args;

  await once(
    context.db,
    'contributions',
    {
      campaign_address: meta.address,
      contributor_address: lower(contributor),
      amount: u256(amount),
      total_raised_after: u256(totalRaised),
      block_time: await context.blockTime(meta.blockNumber),
      ...eventRow(meta),
    },
    'insert contribution',
  );
  await updateCampaign(context, meta, { funded_amount: u256(totalRaised) }, 'update funded amount');
};

const onActivated: Handler<'Activated'> = (context, meta, event) => {
  const { activatedAt, incentivePool, perTreeIncentive, reserveAmount } = event.args;

  return updateCampaign(
    context,
    meta,
    {
      status: 'active',
      activated_at: isoFromSeconds(activatedAt),
      incentive_pool: u256(incentivePool),
      per_tree_incentive: u256(perTreeIncentive),
      reserve_amount: u256(reserveAmount),
    },
    'activate campaign',
  );
};

const onRefunded: Handler<'Refunded'> = async (context, meta, event) => {
  await once(
    context.db,
    'refunds',
    {
      campaign_address: meta.address,
      contributor_address: lower(event.args.contributor),
      amount: u256(event.args.amount),
      block_time: await context.blockTime(meta.blockNumber),
      ...eventRow(meta),
    },
    'insert refund',
  );
};

const onSlotsClaimed = async (
  context: ApplyContext,
  meta: EventMeta,
  args: { planter: string; firstSlotId: bigint; count: bigint },
): Promise<void> => {
  const campaign = await one<{ anchor_slots: number }>(
    context.db,
    'load anchor slot count',
    'select anchor_slots from public.campaigns where address = $1',
    [meta.address],
  );
  const claimedAt = await context.blockTime(meta.blockNumber);
  const first = Number(args.firstSlotId);
  const slots = Array.from({ length: Number(args.count) }, (_slot, offset) => first + offset).map(
    (slotId) => ({
      campaign_address: meta.address,
      slot_id: slotId,
      kind: slotKind(slotId, campaign.anchor_slots),
      status: 'claimed',
      planter_address: lower(args.planter),
      claimed_at: claimedAt,
      claimed_tx: meta.txHash,
    }),
  );

  await insert(
    context.db,
    'upsert claimed slots',
    { table: 'slots', conflict: ['campaign_address', 'slot_id'] },
    slots,
  );
};

const onSlotPlanted: Handler<'SlotPlanted'> = (context, meta, event) =>
  updateWhere(
    context.db,
    'mark slot planted',
    {
      table: 'slots',
      where: 'campaign_address = $1 and slot_id = $2',
      values: [meta.address, Number(event.args.slotId)],
    },
    { status: 'planted', tree_id: Number(event.args.treeId) },
  );

const onMilestonePaid: Handler<'MilestonePaid'> = async (context, meta, event) => {
  const { treeId, milestone, planter, amount } = event.args;

  await once(
    context.db,
    'milestone_payouts',
    {
      campaign_address: meta.address,
      tree_id: Number(treeId),
      milestone,
      planter_address: lower(planter),
      amount: u256(amount),
      block_time: await context.blockTime(meta.blockNumber),
      ...eventRow(meta),
    },
    'insert milestone payout',
  );
};

const onMilestoneForfeited: Handler<'MilestoneForfeited'> = async (context, meta, event) => {
  const { treeId, milestone, amount } = event.args;

  await once(
    context.db,
    'milestone_forfeits',
    {
      campaign_address: meta.address,
      tree_id: Number(treeId),
      milestone,
      amount: u256(amount),
      block_time: await context.blockTime(meta.blockNumber),
      ...eventRow(meta),
    },
    'insert milestone forfeit',
  );
};

const onCampaignCompleted: Handler<'CampaignCompleted'> = async (context, meta, event) =>
  updateCampaign(
    context,
    meta,
    {
      status: 'completed',
      refund_pool: u256(event.args.refundPool),
      completed_at: await context.blockTime(meta.blockNumber),
    },
    'complete campaign',
  );

// BucketsReleased, ReserveDrawn and Initialized carry nothing the mirror stores.
const HANDLERS: { [Name in CampaignEvent['eventName']]?: Handler<Name> } = {
  Contributed: onContributed,
  Activated: onActivated,
  RefundingStarted: (context, meta) =>
    updateCampaign(context, meta, { status: 'refunding' }, 'mark campaign refunding'),
  Refunded: onRefunded,
  SlotsClaimed: (context, meta, event) => onSlotsClaimed(context, meta, event.args),
  AnchorSlotsAssigned: (context, meta, event) => onSlotsClaimed(context, meta, event.args),
  SlotPlanted: onSlotPlanted,
  MilestonePaid: onMilestonePaid,
  MilestoneForfeited: onMilestoneForfeited,
  CampaignCompleted: onCampaignCompleted,
};

export const applyCampaignEvent = async (
  context: ApplyContext,
  meta: EventMeta,
  event: CampaignEvent,
): Promise<void> => {
  const handler = HANDLERS[event.eventName] as Handler<CampaignEvent['eventName']> | undefined;

  if (handler) {
    await handler(context, meta, event as never);
  }
};
