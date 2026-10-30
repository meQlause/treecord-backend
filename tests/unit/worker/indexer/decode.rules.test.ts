import { encodeAbiParameters, encodeEventTopics, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  decodeLogs,
  type RawLog,
  type WatchedAddresses,
} from '../../../../src/worker/indexer/decode.rules.js';
import { treecordKeeperAbi } from '../../../../src/shared/chain/keeper-abi.js';

const KEEPER: Address = '0x959922be3caee4b8cd9a407cc3ac1c251c2007b1';
const CAMPAIGN: Address = '0x0000000000000000000000000000000000000003';
const TX_HASH = `0x${'7'.repeat(64)}` as const;

const watched = (keeper: Address | null): WatchedAddresses => ({
  factory: '0x0000000000000000000000000000000000000f01',
  treeRegistry: '0x0000000000000000000000000000000000000f02',
  gateway: '0x0000000000000000000000000000000000000f03',
  carbonLedger: '0x0000000000000000000000000000000000000f04',
  keeper,
  campaigns: new Set([CAMPAIGN]),
});

// TreecordKeeper.Enforced(0, campaign, 3001, 2): kind, campaign and treeId are indexed, milestone is data
const enforcedLog: RawLog = {
  address: '0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1',
  blockNumber: 24118500n,
  logIndex: 4,
  transactionHash: TX_HASH,
  topics: encodeEventTopics({
    abi: treecordKeeperAbi,
    eventName: 'Enforced',
    args: { kind: 0, campaign: CAMPAIGN, treeId: 3001n },
  }) as RawLog['topics'],
  data: encodeAbiParameters([{ type: 'uint8' }], [2]),
};

describe('decodeLogs — FR-243 TreecordKeeper.Enforced', () => {
  it('decodes a keeper log as source "keeper" when the keeper is watched', () => {
    const [event] = decodeLogs([enforcedLog], watched(KEEPER));

    expect(event).toMatchObject({
      source: 'keeper',
      meta: { address: KEEPER, blockNumber: 24118500n, logIndex: 4, txHash: TX_HASH },
      event: {
        eventName: 'Enforced',
        args: { kind: 0, campaign: CAMPAIGN, treeId: 3001n, milestone: 2 },
      },
    });
  });

  it('ignores keeper logs when no keeper is configured (CHAINLINK_KEEPER_ADDRESS unset)', () => {
    expect(decodeLogs([enforcedLog], watched(null))).toEqual([]);
  });
});
