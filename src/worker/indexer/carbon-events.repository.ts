// CarbonLedger events into the carbon tables. Balances and allocated amounts exist on-chain only as deltas, so they
// are recomputed from the stored event rows instead of being incremented.
import {
  insert,
  once,
  one,
  query,
  sumAmounts,
  updateWhere,
  type Queryable,
} from '../worker-db.repository.js';
import { eventRow, u256 } from './apply.rules.js';
import type { ApplyContext } from './apply.service.js';
import { lower, type EventMeta, type IndexedEvent } from './decode.rules.js';

type CarbonEvent = Extract<IndexedEvent, { source: 'carbonLedger' }>['event'];
type Handler<Name extends CarbonEvent['eventName']> = (
  context: ApplyContext,
  meta: EventMeta,
  event: Extract<CarbonEvent, { eventName: Name }>,
) => Promise<void>;

const NONE = BigInt(0);
const RESERVATION_WHERE = 'campaign_address = $1 and holder_address = $2';

/** Credits allocated to a holder across every batch of a campaign. */
const allocatedFor = async (
  database: Queryable,
  campaign: string,
  holder: string,
): Promise<bigint> => {
  const batches = await query<{ batch_id: number }>(
    database,
    'load campaign batches',
    'select batch_id from public.carbon_batches where campaign_address = $1',
    [campaign],
  );

  if (batches.length === 0) {
    return NONE;
  }

  return sumAmounts(database, 'sum allocations', {
    table: 'carbon_allocations',
    where: 'holder_address = $1 and batch_id = any($2::bigint[])',
    values: [holder, batches.map((batch) => batch.batch_id)],
  });
};

/**
 * Rebuilds one balance from the event tables: allocations plus purchases minus retirements, and for platform
 * inventory (the ledger) minus everything sold. These are the only ways CarbonLedger moves credits.
 */
const refreshBalance = async (
  context: ApplyContext,
  batchId: number,
  holder: string,
  block: bigint,
): Promise<void> => {
  const { db } = context;
  const holderWhere = { values: [batchId, holder] };
  // one after another: they run on the chunk transaction's single connection
  const allocated = await sumAmounts(db, 'sum allocations', {
    table: 'carbon_allocations',
    where: 'batch_id = $1 and holder_address = $2',
    ...holderWhere,
  });
  const bought = await sumAmounts(db, 'sum purchases', {
    table: 'carbon_purchases',
    where: 'batch_id = $1 and buyer_address = $2',
    ...holderWhere,
  });
  const retired = await sumAmounts(db, 'sum retirements', {
    table: 'retirements',
    where: 'batch_id = $1 and holder_address = $2',
    ...holderWhere,
  });
  const sold =
    holder === context.carbonLedger
      ? await sumAmounts(db, 'sum sales', {
          table: 'carbon_purchases',
          where: 'batch_id = $1',
          values: [batchId],
        })
      : NONE;
  const balance = allocated + bought - retired - sold;

  await insert(
    db,
    'upsert carbon balance',
    { table: 'carbon_balances', conflict: ['batch_id', 'holder_address'] },
    {
      batch_id: batchId,
      holder_address: holder,
      amount: u256(balance < NONE ? NONE : balance),
      updated_block: Number(block),
    },
  );
};

const onReservationDeclined: Handler<'ReservationDeclined'> = async (context, _meta, event) => {
  // the contract shrinks the reservation to what was already allocated
  const campaign = lower(event.args.campaign);
  const holder = lower(event.args.holder);
  const allocated = await allocatedFor(context.db, campaign, holder);

  await updateWhere(
    context.db,
    'decline reservation',
    { table: 'carbon_reservations', where: RESERVATION_WHERE, values: [campaign, holder] },
    { reserved_amount: u256(allocated), allocated_amount: u256(allocated), declined: true },
  );
};

const onBatchIssued: Handler<'BatchIssued'> = (context, meta, event) => {
  const args = event.args;

  return insert(
    context.db,
    'upsert carbon batch',
    { table: 'carbon_batches', conflict: ['batch_id'] },
    {
      batch_id: Number(args.batchId),
      campaign_address: lower(args.campaign),
      registry: args.registry,
      serial_start: args.serialStart,
      serial_end: args.serialEnd,
      vintage: args.vintage,
      amount: u256(args.amount),
      issued_block: Number(meta.blockNumber),
      issued_tx: meta.txHash,
    },
  );
};

const refreshAllocated = async (context: ApplyContext, batchId: number, holder: string) => {
  const batch = await one<{ campaign_address: string }>(
    context.db,
    'load batch campaign',
    'select campaign_address from public.carbon_batches where batch_id = $1',
    [batchId],
  );
  const allocated = await allocatedFor(context.db, batch.campaign_address, holder);

  await updateWhere(
    context.db,
    'update allocated amount',
    {
      table: 'carbon_reservations',
      where: RESERVATION_WHERE,
      values: [batch.campaign_address, holder],
    },
    { allocated_amount: u256(allocated) },
  );
};

const onAllocated: Handler<'Allocated'> = async (context, meta, event) => {
  const batchId = Number(event.args.batchId);
  const holder = lower(event.args.holder);

  await once(
    context.db,
    'carbon_allocations',
    {
      batch_id: batchId,
      holder_address: holder,
      amount: u256(event.args.amount),
      ...eventRow(meta),
    },
    'insert allocation',
  );
  await refreshBalance(context, batchId, holder, meta.blockNumber);

  if (holder !== context.carbonLedger) {
    await refreshAllocated(context, batchId, holder);
  }
};

const onPurchased: Handler<'Purchased'> = async (context, meta, event) => {
  const batchId = Number(event.args.batchId);
  const buyer = lower(event.args.buyer);

  await once(
    context.db,
    'carbon_purchases',
    {
      batch_id: batchId,
      buyer_address: buyer,
      amount: u256(event.args.amount),
      usdc_paid: u256(event.args.usdcPaid),
      block_time: await context.blockTime(meta.blockNumber),
      ...eventRow(meta),
    },
    'insert purchase',
  );
  await refreshBalance(context, batchId, buyer, meta.blockNumber);
  await refreshBalance(context, batchId, context.carbonLedger, meta.blockNumber);
};

const onRetired: Handler<'Retired'> = async (context, meta, event) => {
  const args = event.args;
  const holder = lower(args.holder);

  await once(
    context.db,
    'retirements',
    {
      retirement_id: Number(args.retirementId),
      batch_id: Number(args.batchId),
      holder_address: holder,
      amount: u256(args.amount),
      beneficiary: args.beneficiary,
      purpose: args.purpose,
      retired_at: await context.blockTime(meta.blockNumber),
      tx_hash: meta.txHash,
      log_index: meta.logIndex,
    },
    'insert retirement',
  );
  await refreshBalance(context, Number(args.batchId), holder, meta.blockNumber);
};

// ERC-1155 TransferSingle, ApprovalForAll and URI: balances are rebuilt from the events below.
const HANDLERS: { [Name in CarbonEvent['eventName']]?: Handler<Name> } = {
  EstimateSet: (context, _meta, event) =>
    updateWhere(
      context.db,
      'store estimate',
      { table: 'campaigns', where: 'address = $1', values: [lower(event.args.campaign)] },
      { estimated_amount: u256(event.args.estimatedAmount) },
    ),
  Reserved: (context, _meta, event) =>
    insert(
      context.db,
      'upsert reservation',
      { table: 'carbon_reservations', conflict: ['campaign_address', 'holder_address'] },
      {
        campaign_address: lower(event.args.campaign),
        holder_address: lower(event.args.holder),
        reserved_amount: u256(event.args.amount),
      },
    ),
  ReservationDeclined: onReservationDeclined,
  BatchIssued: onBatchIssued,
  Allocated: onAllocated,
  PriceSet: (context, _meta, event) =>
    updateWhere(
      context.db,
      'set batch price',
      { table: 'carbon_batches', where: 'batch_id = $1', values: [Number(event.args.batchId)] },
      { price_usdc_per_tonne: u256(event.args.usdcPerTonne) },
    ),
  Purchased: onPurchased,
  Retired: onRetired,
};

export const applyCarbonEvent = async (
  context: ApplyContext,
  meta: EventMeta,
  event: CarbonEvent,
): Promise<void> => {
  const handler = HANDLERS[event.eventName] as Handler<CarbonEvent['eventName']> | undefined;

  if (handler) {
    await handler(context, meta, event as never);
  }
};
