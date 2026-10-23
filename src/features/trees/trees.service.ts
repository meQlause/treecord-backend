import { DomainError } from '../../shared/errors.js';
import type { Storage } from '../../shared/storage/storage.js';
import { flagEligibility } from '../flags/index.js';
import {
  toMilestones,
  toRecords,
  toTimeline,
  toTree,
  toViewer,
  type Location,
} from './trees.mapper.js';
import type { TreeRow, TreesRepository } from './trees.repository.js';
import { geohashCentre } from './trees.rules.js';

const KEYFRAMES_BUCKET = 'keyframes';

/** FR-054: each timeline entry's first keyframe as a 15-minute link, or null. */
const thumbnailsOf = (
  storage: Pick<Storage, 'presignGet'>,
  timeline: { first_keyframe: string | null }[],
): Promise<(string | null)[]> =>
  Promise.all(
    timeline.map((row) =>
      row.first_keyframe === null ? null : storage.presignGet(KEYFRAMES_BUCKET, row.first_keyframe),
    ),
  );

/** The signed-in caller, as far as the tree page needs it. */
type Caller = { id: string; role: string; wallet_address: string | null };

type TreesDependencies = {
  repository: TreesRepository;
  storage: Pick<Storage, 'presignGet'>;
  /** The latest block's time. No server-clock fallback: a wrong window sends a planter out to record (REG-009). */
  chainNow: () => Promise<Date>;
};

/** docs/BE/features/trees.md §1: the public tree page; a caller adds `viewer` and may see the exact location. */
export const createTreesService = ({ repository, storage, chainNow }: TreesDependencies) => {
  // FR-053: exact for the tree's planter, operators and auditors; everyone else gets the geohash cell's centre
  const locate = async (tree: TreeRow, caller: Caller | undefined): Promise<Location> => {
    const permitted =
      caller !== undefined &&
      (caller.wallet_address === tree.planter_address ||
        caller.role === 'operator' ||
        caller.role === 'auditor');
    const cell: Location = {
      precision: 'geohash',
      ...geohashCentre(tree.geohash),
      geohash: tree.geohash,
    };

    if (!permitted) {
      return cell;
    }

    const { exact_lat: lat, exact_lon: lon } = await repository.exactLocation(tree.tree_id);

    return lat === null || lon === null
      ? cell
      : { precision: 'exact', lat, lon, geohash: tree.geohash };
  };

  const viewerOf = async (tree: TreeRow, caller: Caller) => {
    const isPlanter = caller.wallet_address === tree.planter_address;
    const [contributed, liveSubmissions, pendingFlag] = await Promise.all([
      caller.wallet_address === null
        ? '0'
        : repository.contributed(tree.campaign_address, caller.wallet_address),
      isPlanter ? repository.liveSubmissions(tree.tree_id, caller.id) : [],
      // once someone else's flag is on-chain, a pending one can never land (trees §1 Flags)
      tree.status === 'alive' || tree.status === 'dead'
        ? repository.pendingFlag(tree.tree_id, caller.id)
        : undefined,
    ]);
    const flag = flagEligibility({
      wallet: caller.wallet_address,
      contributed,
      treeStatus: tree.status,
    });

    return toViewer(isPlanter, flag, { liveSubmissions, pendingFlag });
  };

  return {
    page: async (treeId: string, caller: Caller | undefined) => {
      const tree = await repository.tree(treeId);

      if (tree === undefined) {
        throw new DomainError('not_found');
      }

      const [now, location, timeline, payouts, forfeits, flags, viewer] = await Promise.all([
        chainNow(),
        locate(tree, caller),
        repository.timeline(treeId),
        repository.payouts(treeId),
        repository.forfeits(treeId),
        repository.flags(treeId),
        caller === undefined ? null : viewerOf(tree, caller),
      ]);
      const records = { timeline, payouts, forfeits, flags };
      const thumbnails = await thumbnailsOf(storage, timeline);

      return {
        tree: toTree(tree, location),
        timeline: toTimeline(timeline, thumbnails),
        milestones: toMilestones(tree, records, now),
        ...toRecords(tree, records),
        viewer,
      };
    },
  };
};
