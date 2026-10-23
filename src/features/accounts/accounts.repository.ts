import type { Kysely, Selectable } from 'kysely';
import type { DB, Profiles } from '../../generated/db.js';

export type ProfileRow = Selectable<Profiles>;

export type AccountsRepository = ReturnType<typeof accountsRepository>;

export const accountsRepository = (database: Kysely<DB>) => ({
  byPrivyUserId: (privyUserId: string): Promise<ProfileRow | undefined> =>
    database
      .selectFrom('profiles')
      .selectAll()
      .where('privy_user_id', '=', privyUserId)
      .executeTakeFirst(),

  /** accounts §0 step 4: the privy_user_id key absorbs a concurrent first sign-in. */
  insertIgnoringExisting: async (
    privyUserId: string,
    walletAddress: string | null,
  ): Promise<void> => {
    await database
      .insertInto('profiles')
      .values({ privy_user_id: privyUserId, wallet_address: walletAddress })
      .onConflict((conflict) => conflict.column('privy_user_id').doNothing())
      .execute();
  },

  /** accounts §0 step 5: only fills a wallet the profile does not have yet. */
  setWalletIfMissing: async (id: string, walletAddress: string): Promise<void> => {
    await database
      .updateTable('profiles')
      .set({ wallet_address: walletAddress })
      .where('id', '=', id)
      .where('wallet_address', 'is', null)
      .execute();
  },
});
