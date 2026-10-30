// TreecordKeeper's one event (contracts/src/TreecordKeeper.sol, FR-243). Not frozen: the keeper is configuration,
// found through CHAINLINK_KEEPER_ADDRESS, and never part of the frozen deployment (ADR-022).
import { parseAbi } from 'viem';

export const treecordKeeperAbi = parseAbi([
  'event Enforced(uint8 indexed kind, address indexed campaign, uint256 indexed treeId, uint8 milestone)',
]);
