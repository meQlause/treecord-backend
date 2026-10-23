import { keccak256, stringToHex } from 'viem';
import type { DatabaseClient } from '../../shared/db/database.js';
import { DomainError } from '../../shared/errors.js';
import { enqueue, enqueuedResponse } from '../jobs/index.js';
import { flagEligibility } from './flags.rules.js';
import { flagsRepository } from './flags.repository.js';
import type { RaiseFlagInput, ResolveFlagInput } from './flags.schema.js';

type Caller = { id: string; wallet_address: string | null };

/** keccak256 of the UTF-8 text: what the contract stores (flags §1, §3). */
const textHash = (text: string): string => keccak256(stringToHex(text));

/** docs/BE/features/flags.md §1, §3: a contributor saves a reason, an operator queues the decision. The API never
 *  changes a flag's status; only indexed events do (ADR-015). */
export const createFlagsService = ({ database }: { database: DatabaseClient }) => {
  const repository = flagsRepository(database);

  return {
    /** §1: one pending row per (tree, caller, text); a repeat reads it back. Checked in the §1 order. */
    raise: async (caller: Caller, { treeId, reasonText }: RaiseFlagInput) => {
      const wallet = caller.wallet_address;

      if (wallet === null) {
        throw new DomainError('wallet_missing');
      }

      const tree = await repository.tree(treeId);

      if (tree === undefined) {
        throw new DomainError('not_found');
      }

      const { blockedBy } = flagEligibility({
        wallet,
        contributed: await repository.contributed(tree.campaign_address, wallet),
        treeStatus: tree.status,
      });

      if (blockedBy !== null) {
        throw new DomainError(blockedBy);
      }

      const reasonHash = textHash(reasonText);
      const created = await repository.insertPending({
        treeId,
        campaign: tree.campaign_address,
        wallet,
        profileId: caller.id,
        reasonText,
        reasonHash,
      });

      return created === undefined
        ? { flag: await repository.pending(treeId, caller.id, reasonHash), idempotent: true }
        : { flag: created, idempotent: false };
    },

    /** §3: the flag id is the job key, so one live decision per flag. The job first (jobs §3 R2–R5), then the
     *  status check, which rolls the job back when it refuses. */
    resolve: async (caller: Caller, flagId: string, { uphold, note }: ResolveFlagInput) => {
      const flag = await repository.byId(flagId);

      if (flag === undefined) {
        throw new DomainError('not_found');
      }

      const noteHash = textHash(note);

      return database.transaction().execute(async (trx) => {
        const queued = await enqueue(trx, {
          kind: 'resolve_flag',
          payload: { treeId: flag.tree_id, uphold, noteHash },
          createdBy: caller.id,
          idempotencyKey: `resolve_flag:${flag.id}`,
        });

        if (queued.outcome === 'replayed') {
          if ((queued.job.payload as { uphold: boolean }).uphold !== uphold) {
            throw new DomainError('flag_resolution_pending');
          }

          return enqueuedResponse(queued);
        }

        if (flag.status !== 'open') {
          throw new DomainError('flag_not_open', { status: flag.status });
        }

        await flagsRepository(trx).writeResolution(flag.id, {
          note,
          noteHash,
          profileId: caller.id,
        });

        return enqueuedResponse(queued);
      });
    },
  };
};
