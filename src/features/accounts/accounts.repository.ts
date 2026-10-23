import { sql, type Kysely, type Selectable } from 'kysely';
import type { DB, Profiles } from '../../generated/db.js';
import type { UpdateProfileInput } from './accounts.schema.js';

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

  /**
   * accounts §2 "Write": one statement, no read-then-write. Acceptance is set once (coalesce); the role guard in the
   * where clause makes role_locked race-free. An absent field leaves its column unchanged; updated_at is the trigger's.
   */
  updateProfile: (
    id: string,
    input: UpdateProfileInput,
    agreementHash: string,
  ): Promise<ProfileRow | undefined> =>
    database
      .updateTable('profiles')
      .set({
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
        ...(input.isBuyer === undefined ? {} : { is_buyer: input.isBuyer }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.carbonRightsAgreementAccepted === true
          ? {
              carbon_rights_agreement_hash: sql<string>`coalesce(carbon_rights_agreement_hash, ${agreementHash})`,
              carbon_rights_accepted_at: sql<Date>`coalesce(carbon_rights_accepted_at, now())`,
            }
          : {}),
      })
      .where('id', '=', id)
      .$if(input.role !== undefined, (query) => query.where('role', 'in', ['donor', 'planter']))
      .returningAll()
      .executeTakeFirst(),
});
