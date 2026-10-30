import { once } from '../worker-db.repository.js';
import type { ApplyContext } from './apply.service.js';
import { eventRow } from './apply.rules.js';
import { lower, type EventMeta } from './decode.rules.js';

/** TreecordKeeper.Enforced `kind`: 0 forfeited a milestone, 1 expired a dead tree (FR-243). */
const KINDS = ['forfeit', 'expire'] as const;

/** Mirrors one Enforced log into chainlink_enforcements (data-spec §5.2.6); a replayed log is ignored. */
export const onEnforced = async (
  context: ApplyContext,
  meta: EventMeta,
  args: { kind: number; campaign: string; treeId: bigint; milestone: number },
): Promise<void> => {
  const kind = KINDS[args.kind];

  if (kind === undefined) {
    context.log.warn({ kind: args.kind, tx: meta.txHash }, 'unknown keeper enforcement kind');

    return;
  }

  await once(
    context.db,
    'chainlink_enforcements',
    {
      kind,
      campaign_address: lower(args.campaign),
      tree_id: Number(args.treeId),
      milestone: kind === 'forfeit' ? args.milestone : null,
      block_time: await context.blockTime(meta.blockNumber),
      ...eventRow(meta),
    },
    'insert chainlink enforcement',
  );
};
