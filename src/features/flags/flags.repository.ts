import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, Flags } from '../../generated/db.js';

export type FlagRow = Selectable<Flags>;

type NewFlag = {
  treeId: string;
  campaign: string;
  wallet: string;
  profileId: string;
  reasonText: string;
  reasonHash: string;
};

type Resolution = { note: string; noteHash: string; profileId: string };

export const flagsRepository = (database: Kysely<DB>) => ({
  tree: (treeId: string) =>
    database
      .selectFrom('trees')
      .select(['tree_id', 'campaign_address', 'status'])
      .where('tree_id', '=', treeId)
      .executeTakeFirst(),

  /** flags §4 row 2: Σ contributions.amount of the wallet to the campaign, as a decimal string. */
  contributed: async (campaign: string, wallet: string): Promise<string> =>
    (
      await database
        .selectFrom('contributions')
        .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
        .where('campaign_address', '=', campaign)
        .where('contributor_address', '=', wallet)
        .executeTakeFirstOrThrow()
    ).total,

  /** §1 concurrency: flags_one_pending_per_flagger_idx makes a repeat a no-op; undefined means it already existed. */
  insertPending: (flag: NewFlag): Promise<FlagRow | undefined> =>
    database
      .insertInto('flags')
      .values({
        tree_id: flag.treeId,
        campaign_address: flag.campaign,
        flagger_address: flag.wallet,
        flagger_profile_id: flag.profileId,
        reason_text: flag.reasonText,
        reason_hash: flag.reasonHash,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['tree_id', 'flagger_profile_id', 'reason_hash'])
          .where('status', '=', 'pending')
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst(),

  /** §1: the caller's pending row the conflicting insert met. */
  pending: (treeId: string, profileId: string, reasonHash: string): Promise<FlagRow> =>
    database
      .selectFrom('flags')
      .selectAll()
      .where('tree_id', '=', treeId)
      .where('flagger_profile_id', '=', profileId)
      .where('reason_hash', '=', reasonHash)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow(),

  byId: (id: string): Promise<FlagRow | undefined> =>
    database.selectFrom('flags').selectAll().where('id', '=', id).executeTakeFirst(),

  /** §3 side effects: the note and who decided; the status stays the indexer's (ADR-015). */
  writeResolution: async (id: string, { note, noteHash, profileId }: Resolution): Promise<void> => {
    await database
      .updateTable('flags')
      .set({ resolution_note: note, note_hash: noteHash, resolved_by_profile_id: profileId })
      .where('id', '=', id)
      .execute();
  },
});
