// Writes decoded chain events into the PostgreSQL mirror (docs/database.md).
//
// Every write is idempotent, so a chunk can be applied again after a crash or during the reorg re-scan:
// - event rows are inserted once per (tx_hash, log_index), and a duplicate insert is ignored
//   (ON CONFLICT DO NOTHING, which also keeps the indexer's chunk transaction usable)
// - state columns are set to absolute values carried by the event (totalRaised, checkInCount, ...)
// - values that only exist as deltas on-chain (paused seconds, balances, allocated amounts) are recomputed from the
//   stored event rows instead of being incremented
// Events are applied in chain order, so re-applying a range ends in the same state.
import type { Address } from 'viem';
import type { Logger, Queryable } from '../worker-db.repository.js';
import { onAttestationAccepted } from './attestation-events.repository.js';
import { applyCampaignEvent, onCampaignCreated } from './campaign-events.repository.js';
import { applyCarbonEvent } from './carbon-events.repository.js';
import type { IndexedEvent } from './decode.rules.js';
import { applyTreeEvent } from './tree-events.repository.js';

export type ApplyContext = {
  /** The indexer's chunk transaction. */
  db: Queryable;
  chainId: number;
  /** Lowercase CarbonLedger address. Platform inventory is held by the ledger itself. */
  carbonLedger: Address;
  /** ISO timestamp of a block. Cached by the caller. */
  blockTime: (blockNumber: bigint) => Promise<string>;
  log: Logger;
};

export const applyEvent = async (context: ApplyContext, indexed: IndexedEvent): Promise<void> => {
  switch (indexed.source) {
    case 'factory':
      if (indexed.event.eventName === 'CampaignCreated') {
        await onCampaignCreated(context, indexed.meta, indexed.event.args);
      }

      return;
    case 'campaign':
      return applyCampaignEvent(context, indexed.meta, indexed.event);
    case 'treeRegistry':
      return applyTreeEvent(context, indexed.meta, indexed.event);
    case 'gateway':
      if (indexed.event.eventName === 'AttestationAccepted') {
        await onAttestationAccepted(context, indexed.meta, indexed.event.args.nonce);
      }

      return;
    case 'carbonLedger':
      return applyCarbonEvent(context, indexed.meta, indexed.event);
  }
};
