import type { FlagRow } from './flags.repository.js';

/** What the frozen indexer writes into the `flagged` event's data (apply.ts onTreeFlagged). */
type FlaggedData = { flagger?: string; previousStatus?: string };

type OperatorFlagRow = FlagRow & { tree_status: string; campaign_title: string | null };

/** flags §2, FR-170: the flag and its tree as S29 shows them. The flagger and the status before come from the
 *  indexed event, not the row: if two contributors saved identical text, the frozen indexer links the oldest pending
 *  row to whoever sent the transaction. A `pending` flag has no event: the saver is the flagger, nothing came before. */
export const toOperatorFlag = (row: OperatorFlagRow, eventData: unknown) => {
  const event = (eventData ?? {}) as FlaggedData;

  return {
    flag: {
      id: row.id,
      treeId: row.tree_id,
      status: row.status,
      reasonText: row.reason_text,
      reasonHash: row.reason_hash,
      flaggerAddress: event.flagger ?? row.flagger_address,
      openedAt: row.opened_at?.toISOString() ?? null,
      openedTxHash: row.opened_tx,
      previousStatus: event.previousStatus ?? null,
      resolutionNote: row.resolution_note,
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      resolvedTxHash: row.resolved_tx,
    },
    tree: {
      treeId: row.tree_id,
      status: row.tree_status,
      campaign: { address: row.campaign_address, title: row.campaign_title },
    },
  };
};
