// Decodes raw logs from Treecord contracts into typed events. Pure: no I/O.
import {
  AbiEventSignatureNotFoundError,
  decodeEventLog,
  type Address,
  type DecodeEventLogReturnType,
  type Hex,
} from 'viem';
import {
  campaignAbi,
  campaignFactoryAbi,
  carbonLedgerAbi,
  treeRegistryAbi,
  verificationGatewayAbi,
} from '../../generated/frozen/abis/index.js';

/** Which contract a log came from. Campaign clones are discovered from CampaignCreated. */
type LogSource = 'factory' | 'campaign' | 'treeRegistry' | 'gateway' | 'carbonLedger';

/** The fields of an eth_getLogs entry the indexer needs. */
export type RawLog = {
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
};

export type EventMeta = {
  /** Lowercase emitting contract. */
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  /** Lowercase transaction hash. */
  txHash: Hex;
};

export type IndexedEvent =
  | {
      source: 'factory';
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof campaignFactoryAbi>;
    }
  | { source: 'campaign'; meta: EventMeta; event: DecodeEventLogReturnType<typeof campaignAbi> }
  | {
      source: 'treeRegistry';
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof treeRegistryAbi>;
    }
  | {
      source: 'gateway';
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof verificationGatewayAbi>;
    }
  | {
      source: 'carbonLedger';
      meta: EventMeta;
      event: DecodeEventLogReturnType<typeof carbonLedgerAbi>;
    };

/** Contract addresses the indexer watches, all lowercase. */
export type WatchedAddresses = {
  factory: Address;
  treeRegistry: Address;
  gateway: Address;
  carbonLedger: Address;
  campaigns: Set<Address>;
};

const ABIS = {
  factory: campaignFactoryAbi,
  campaign: campaignAbi,
  treeRegistry: treeRegistryAbi,
  gateway: verificationGatewayAbi,
  carbonLedger: carbonLedgerAbi,
} as const;

export const lower = <Value extends string>(value: Value): Value => value.toLowerCase() as Value;

const sourceOf = (address: Address, watched: WatchedAddresses): LogSource | null => {
  const lowered = lower(address);
  const fixed: [Address, LogSource][] = [
    [watched.factory, 'factory'],
    [watched.treeRegistry, 'treeRegistry'],
    [watched.gateway, 'gateway'],
    [watched.carbonLedger, 'carbonLedger'],
  ];
  const match = fixed.find(([watchedAddress]) => watchedAddress === lowered);

  if (match) {
    return match[1];
  }

  return watched.campaigns.has(lowered) ? 'campaign' : null;
};

/**
 * Decodes one log. Returns null for logs from unknown addresses and for events the indexer does not mirror (role
 * changes, ERC-1155 transfers, initialization), which are not in the ABI subset or are skipped.
 */
const decodeLog = (log: RawLog, watched: WatchedAddresses): IndexedEvent | null => {
  const source = sourceOf(log.address, watched);

  if (!source || log.topics.length === 0) {
    return null;
  }

  const meta: EventMeta = {
    address: lower(log.address),
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    txHash: lower(log.transactionHash),
  };

  try {
    const event = decodeEventLog({
      abi: ABIS[source],
      data: log.data,
      topics: log.topics,
      strict: true,
    });

    return { source, meta, event } as IndexedEvent;
  } catch (error) {
    if (error instanceof AbiEventSignatureNotFoundError) {
      return null;
    }

    throw error;
  }
};

/** Chain order: block number, then log index. */
const compareEvents = (left: { meta: EventMeta }, right: { meta: EventMeta }): number => {
  if (left.meta.blockNumber !== right.meta.blockNumber) {
    return left.meta.blockNumber < right.meta.blockNumber ? -1 : 1;
  }

  return left.meta.logIndex - right.meta.logIndex;
};

/** Decodes a batch of logs and returns them in chain order. */
export const decodeLogs = (logs: RawLog[], watched: WatchedAddresses): IndexedEvent[] =>
  logs
    .map((log) => decodeLog(log, watched))
    .filter((event): event is IndexedEvent => event !== null)
    .sort(compareEvents);
