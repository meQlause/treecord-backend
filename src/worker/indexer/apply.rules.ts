// The indexer's pure decisions: identifiers carried in events, slot kinds, and a tree's state after a dismissed flag.
import { hexToString, type Hex } from 'viem';
import type { EventMeta } from './decode.rules.js';

export type TreeStatus = 'alive' | 'flagged' | 'dead' | 'removed' | 'completed';

export type TimelineEvent = {
  kind: string;
  data: unknown;
  block_number: number;
  log_index: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_LENGTH = 36;
const BYTES32 = 32;
const BPS = 10_000;

/** uint256 columns are written as decimal strings (docs/database.md). */
export const u256 = (value: bigint): string => value.toString();

/** The campaign_metadata id at the end of a metadataURI from POST /campaigns/metadata, if any. */
export const metadataIdFromUri = (uri: string): string | null => {
  // the UUID is the last 36 characters, before an optional trailing slash
  const tail = (uri.endsWith('/') ? uri.slice(0, -1) : uri).slice(-UUID_LENGTH);

  return UUID.test(tail) ? tail.toLowerCase() : null;
};

/** A bytes32 species code such as bytes32("SWIETENIA_MACROPHYLLA") as text. */
export const speciesCodeFromBytes32 = (value: Hex): string => {
  const text = hexToString(value, { size: BYTES32 });
  let end = text.length;

  // bytes32 strings are padded with NUL bytes at the end
  while (end > 0 && text[end - 1] === '\0') {
    end -= 1;
  }

  return text.slice(0, end);
};

/** The block, transaction and log columns every event table shares. */
export const eventRow = (
  meta: EventMeta,
): { block_number: number; tx_hash: string; log_index: number } => ({
  block_number: Number(meta.blockNumber),
  tx_hash: meta.txHash,
  log_index: meta.logIndex,
});

/** Anchor slots are the first `anchorBps` of the target, rounded down; the rest are open. */
export const anchorSlotCount = (treeTarget: number, anchorBps: number): number =>
  Math.floor((treeTarget * anchorBps) / BPS);

/** A claimed slot keeps its kind: rolled-over open slots assigned by an operator stay open. */
export const slotKind = (slotId: number, anchorSlots: number): 'anchor' | 'open' =>
  slotId <= anchorSlots ? 'anchor' : 'open';

/** TreeRemoved carries reason 0 for an expired replant, anything else for an upheld flag. */
export const removalReason = (reason: number): 'replant_expired' | 'flag_upheld' =>
  reason === 0 ? 'replant_expired' : 'flag_upheld';

type TreeState = {
  status: TreeStatus;
  pausedSeconds: number;
  replantDeadlineSec: number | null;
  previousStatus: TreeStatus;
};

type EventData = Record<string, unknown>;

const dismiss = (state: TreeState, paused: number): TreeState => {
  const status = state.previousStatus;
  const movesDeadline = status === 'dead' && state.replantDeadlineSec !== null;

  return {
    ...state,
    status,
    pausedSeconds: state.pausedSeconds + paused,
    replantDeadlineSec: movesDeadline
      ? (state.replantDeadlineSec ?? 0) + paused
      : state.replantDeadlineSec,
  };
};

const STEPS: Record<string, (state: TreeState, data: EventData) => TreeState> = {
  died: (state, data) => ({
    ...state,
    status: 'dead',
    replantDeadlineSec: Number(data['replantDeadline'] ?? 0),
  }),
  replanted: (state) => ({ ...state, status: 'alive', replantDeadlineSec: null }),
  flagged: (state, data) => ({
    ...state,
    previousStatus: (data['previousStatus'] as TreeStatus | undefined) ?? state.status,
    status: 'flagged',
  }),
  flag_resolved: (state, data) =>
    data['upheld'] === true ? state : dismiss(state, Number(data['pausedSeconds'] ?? 0)),
  removed: (state) => ({ ...state, status: 'removed' }),
  completed: (state) => ({ ...state, status: 'completed' }),
};

const notAfter =
  (position: Pick<EventMeta, 'blockNumber' | 'logIndex'>) =>
  (event: TimelineEvent): boolean => {
    const atBlock = Number(position.blockNumber);

    return (
      event.block_number < atBlock ||
      (event.block_number === atBlock && event.log_index <= position.logIndex)
    );
  };

/**
 * Tree state after the dismissal at `at`, rebuilt from the timeline (in chain order) up to and including it, the
 * way TreeRegistry.resolveFlag computes it: the status before the flag comes back, every dismissed flag's duration
 * adds to the pause offset, and a dead tree's replant deadline moves by the durations since it died.
 */
export const treeStateAfterDismissal = (
  timeline: TimelineEvent[],
  position: Pick<EventMeta, 'blockNumber' | 'logIndex'>,
): { status: TreeStatus; pausedSeconds: number; replantDeadlineSec: number | null } => {
  const initial: TreeState = {
    status: 'alive',
    pausedSeconds: 0,
    replantDeadlineSec: null,
    previousStatus: 'alive',
  };
  const final = timeline.filter(notAfter(position)).reduce((state, event) => {
    const step = STEPS[event.kind];

    return step ? step(state, (event.data ?? {}) as EventData) : state;
  }, initial);

  return {
    status: final.status,
    pausedSeconds: final.pausedSeconds,
    replantDeadlineSec: final.replantDeadlineSec,
  };
};
